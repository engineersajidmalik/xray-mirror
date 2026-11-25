// MediaPipe face + hand tracking (in web workers) and head-pose post-processing.
import type { FaceLandmarkerResult, HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import type { Delegate, Task, WorkerIn, WorkerOut } from "./detector.worker";
import { OneEuro } from "./filters";

/** MediaPipe solves the face pose for a virtual camera with this vertical field of view. */
export const MEDIAPIPE_FOV_DEG = 63;
/** Assumed horizontal field of view of a typical laptop webcam, for the distance estimate. */
const WEBCAM_HFOV_DEG = 60;
const IRIS_DIAMETER_CM = 1.17;
/** Frames are downscaled to this width before detection. */
const DETECT_WIDTH = 640;

// Rigid canonical face points (cm) used to check how well the 3D pose lines up on screen.
const FIT_POINTS: Record<number, [number, number, number]> = {
  33: [-4.445859, 2.663991, 3.173422],
  133: [-1.856432, 2.585245, 3.757904],
  263: [4.445859, 2.663991, 3.173422],
  362: [1.856432, 2.585245, 3.757904],
  168: [0, 3.271027, 5.236015],
  6: [0, 2.473255, 5.788627],
  1: [0, -1.126865, 7.475604],
  10: [0, 8.261778, 4.481535],
};

/** Optional override for testing/tuning: ?delegate=CPU or ?delegate=GPU in the page URL. */
const forced = new URLSearchParams(location.search).get("delegate")?.toUpperCase();
const FORCED: Delegate | null = forced === "CPU" || forced === "GPU" ? forced : null;

/** One detection worker: at most one frame in flight, newer frames are skipped meanwhile. */
class Channel<R> {
  private worker = new Worker(new URL("./detector.worker.ts", import.meta.url), { type: "module" });
  private busy = false;
  private latest: R | null = null;
  delegate: Delegate = "GPU";
  ms = 0; // detection time per frame (smoothed)
  private stamps: number[] = []; // result times in the last 2 s
  /** Minimum time between submitted frames (ms); 0 = as fast as the worker allows. */
  minInterval = 0;
  private lastSubmit = 0;

  constructor(private task: Task) {}

  init(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
        const msg = e.data;
        if (msg.type === "ready") {
          this.delegate = msg.delegate;
          resolve();
        } else if (msg.type === "error") {
          reject(new Error(`${this.task} model: ${msg.message}`));
        } else {
          this.stamps.push(performance.now());
          this.ms = this.ms ? 0.9 * this.ms + 0.1 * msg.ms : msg.ms;
          this.latest = msg.result as R;
          this.busy = false;
        }
      };
      this.worker.onerror = (e) => reject(new Error(`${this.task} worker: ${e.message}`));
      const base = new URL(import.meta.env.BASE_URL, location.href).href;
      this.worker.postMessage({ type: "init", task: this.task, base, delegate: FORCED } satisfies WorkerIn);
    });
  }

  async submit(video: HTMLVideoElement): Promise<void> {
    const now = performance.now();
    if (this.busy || now - this.lastSubmit < this.minInterval) return;
    this.busy = true;
    this.lastSubmit = now;
    try {
      // Detection does not need full resolution: 640 px wide keeps uploads small (landmarks are normalized).
      const scale = Math.min(1, DETECT_WIDTH / video.videoWidth);
      const bitmap = await createImageBitmap(video, { resizeWidth: Math.round(video.videoWidth * scale), resizeHeight: Math.round(video.videoHeight * scale) });
      this.worker.postMessage({ type: "frame", bitmap } satisfies WorkerIn, [bitmap]);
    } catch {
      this.busy = false; // e.g. video not ready yet
    }
  }

  /** The newest result since the last call, or null. */
  take(): R | null {
    const r = this.latest;
    this.latest = null;
    return r;
  }

  /** Results per second over the last 2 seconds. */
  get rate(): number {
    const now = performance.now();
    while (this.stamps.length && now - this.stamps[0] > 2000) this.stamps.shift();
    return this.stamps.length / 2;
  }
}

export class Tracker {
  readonly face = new Channel<FaceLandmarkerResult>("face");
  readonly hands = new Channel<HandLandmarkerResult>("hands");

  get delegate(): Delegate {
    return this.face.delegate;
  }

  async init(onStep: (msg: string) => void): Promise<void> {
    onStep("Loading the face and hand tracking models ...\nThe first start prepares the graphics chip, which can take 10-20 seconds.");
    await Promise.all([this.face.init(), this.hands.init()]);
  }

  private handSeenAt = 0;

  /** Hands the current video frame to the workers that are free. */
  submit(video: HTMLVideoElement, wantHands: boolean): void {
    this.face.submit(video);
    // With no hand in view, look for one only ~4 times a second: frees the GPU for the face.
    this.hands.minInterval = performance.now() - this.handSeenAt < 1000 ? 0 : 250;
    if (wantHands) this.hands.submit(video);
  }

  /** Call with each hand result so idle throttling knows whether hands are in view. */
  noteHands(count: number): void {
    if (count > 0) this.handSeenAt = performance.now();
  }
}

export interface HeadPose {
  tracked: boolean;
  matrix: Matrix4; // canonical face space (cm) -> camera space
  jawOpen: number; // 0..1
  distanceCm: number | null;
  turn: number; // degrees
  nod: number;
  tilt: number;
  fitScale: number; // screen-space correction
  fitShift: [number, number]; // NDC
  landmarks: NormalizedLandmark[] | null;
}

/** Smooths the face pose and derives distance, angles, jaw and the screen fit. */
export class HeadPoseFilter {
  private pos = new OneEuro(1.2, 0.05);
  private rot = new OneEuro(1.0, 0.6);
  private scl = new OneEuro(0.8, 0.5);
  private jaw = new OneEuro(3.0, 1.0);
  private fit = new OneEuro(0.6, 0.5);
  private prevQuat = new Quaternion();
  private lostSince = -1;
  readonly pose: HeadPose = {
    tracked: false,
    matrix: new Matrix4(),
    jawOpen: 0,
    distanceCm: null,
    turn: 0,
    nod: 0,
    tilt: 0,
    fitScale: 1,
    fitShift: [0, 0],
    landmarks: null,
  };

  update(result: FaceLandmarkerResult, tSeconds: number, videoW: number, videoH: number): HeadPose {
    const p = this.pose;
    const data = result.facialTransformationMatrixes?.[0]?.data;
    const lms = result.faceLandmarks?.[0];
    if (!data || !lms) {
      if (p.tracked && this.lostSince < 0) this.lostSince = tSeconds;
      // Keep the last pose briefly so a single missed frame does not blink.
      if (this.lostSince >= 0 && tSeconds - this.lostSince > 0.3) {
        p.tracked = false;
        p.landmarks = null;
        for (const f of [this.pos, this.rot, this.scl, this.jaw, this.fit]) f.reset();
      }
      return p;
    }
    this.lostSince = -1;
    p.tracked = true;
    p.landmarks = lms;

    // MediaPipe's matrix array is column-major, as Matrix4.fromArray expects.
    const raw = new Matrix4().fromArray(data);
    const position = new Vector3(), quat = new Quaternion(), scale = new Vector3();
    raw.decompose(position, quat, scale);
    if (quat.dot(this.prevQuat) < 0) quat.set(-quat.x, -quat.y, -quat.z, -quat.w); // stay in one hemisphere
    const q = this.rot.filter([quat.x, quat.y, quat.z, quat.w], tSeconds);
    quat.set(q[0], q[1], q[2], q[3]).normalize();
    this.prevQuat.copy(quat);
    position.fromArray(this.pos.filter(position.toArray(), tSeconds));
    const s = this.scl.filter([(scale.x + scale.y + scale.z) / 3], tSeconds)[0];
    p.matrix.compose(position, quat, new Vector3(s, s, s));

    const euler = new Euler().setFromQuaternion(quat, "YXZ");
    p.turn = (euler.y * 180) / Math.PI;
    p.nod = (euler.x * 180) / Math.PI;
    p.tilt = (euler.z * 180) / Math.PI;

    const jawOpen = result.faceBlendshapes?.[0]?.categories.find((c) => c.categoryName === "jawOpen")?.score ?? 0;
    p.jawOpen = Math.min(1, Math.max(0, this.jaw.filter([jawOpen], tSeconds)[0]));

    // Distance from the iris size (average iris diameter ~11.7 mm).
    if (lms.length >= 478) {
      const d = (a: number, b: number) => Math.hypot((lms[a].x - lms[b].x) * videoW, (lms[a].y - lms[b].y) * videoH);
      const irisPx = (d(469, 471) + d(474, 476)) / 2;
      const focalPx = videoW / 2 / Math.tan(((WEBCAM_HFOV_DEG / 2) * Math.PI) / 180);
      p.distanceCm = irisPx > 1 ? (focalPx * IRIS_DIAMETER_CM) / irisPx : null;
    }
    return p;
  }

  /**
   * Screen fit: projects rigid canonical points through the pose and the
   * camera projection, compares them with the detected landmarks and returns a
   * smoothed isotropic scale + shift (in NDC) that removes any residual
   * mismatch (e.g. from the assumed field of view).
   */
  updateScreenFit(projection: Matrix4, aspect: number, tSeconds: number): void {
    const p = this.pose;
    if (!p.tracked || !p.landmarks) return;
    const mvp = new Matrix4().multiplyMatrices(projection, p.matrix);
    const q: [number, number][] = [], d: [number, number][] = [];
    for (const [idx, c] of Object.entries(FIT_POINTS)) {
      const v = new Vector3(...c).applyMatrix4(mvp);
      const lm = p.landmarks[Number(idx)];
      q.push([v.x * aspect, v.y]);
      d.push([(lm.x * 2 - 1) * aspect, 1 - lm.y * 2]);
    }
    const mean = (pts: [number, number][]) => pts.reduce((a, b) => [a[0] + b[0] / pts.length, a[1] + b[1] / pts.length], [0, 0]);
    const qm = mean(q), dm = mean(d);
    let num = 0, den = 0;
    q.forEach((qi, i) => {
      const a = [qi[0] - qm[0], qi[1] - qm[1]], b = [d[i][0] - dm[0], d[i][1] - dm[1]];
      num += a[0] * b[0] + a[1] * b[1];
      den += a[0] * a[0] + a[1] * a[1];
    });
    const s = den > 1e-9 ? Math.min(1.5, Math.max(0.67, num / den)) : 1;
    const shift = [(dm[0] - s * qm[0]) / aspect, dm[1] - s * qm[1]];
    const f = this.fit.filter([s, shift[0], shift[1]], tSeconds);
    p.fitScale = f[0];
    p.fitShift = [f[1], f[2]];
  }
}

/**
 * Display-rate interpolation: detection delivers poses ~10-30 times a second;
 * every rendered frame glides toward the newest one (time constant TAU), so
 * the overlay moves smoothly at the camera's frame rate.
 */
export class PoseFollower {
  readonly matrix = new Matrix4();
  jawOpen = 0;
  private pos = new Vector3();
  private quat = new Quaternion();
  private scale = new Vector3();
  private ready = false;
  private static readonly TAU = 0.05; // seconds

  follow(target: HeadPose, dt: number): void {
    const pos = new Vector3(), quat = new Quaternion(), scale = new Vector3();
    target.matrix.decompose(pos, quat, scale);
    const a = this.ready ? 1 - Math.exp(-dt / PoseFollower.TAU) : 1;
    this.pos.lerp(pos, a);
    this.quat.slerp(quat, a);
    this.scale.lerp(scale, a);
    this.jawOpen += (target.jawOpen - this.jawOpen) * a;
    this.ready = true;
    this.matrix.compose(this.pos, this.quat, this.scale);
  }

  reset(): void {
    this.ready = false;
  }
}
