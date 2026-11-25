/// <reference lib="webworker" />
// Runs one MediaPipe task (face or hands) off the main thread, so detection
// never blocks rendering. Frames arrive as transferred ImageBitmaps.
import { FaceLandmarker, FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

export type Task = "face" | "hands";
export type Delegate = "GPU" | "CPU";
export type WorkerIn =
  | { type: "init"; task: Task; base: string; delegate: Delegate | null }
  | { type: "frame"; bitmap: ImageBitmap };
export type WorkerOut =
  | { type: "ready"; delegate: Delegate }
  | { type: "error"; message: string }
  | { type: "result"; result: unknown; ms: number };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let detector: FaceLandmarker | HandLandmarker | null = null;
let lastTs = -1;

async function init(task: Task, base: string, forced: Delegate | null): Promise<Delegate> {
  const fileset = await FilesetResolver.forVisionTasks(`${base}mediapipe`, true);
  const make = (delegate: Delegate) =>
    task === "face"
      ? FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/face_landmarker.task`, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        })
      : HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: `${base}models/hand_landmarker.task`, delegate },
          runningMode: "VIDEO",
          numHands: 2,
        });
  let delegate: Delegate = forced ?? "GPU";
  try {
    detector = await make(delegate);
  } catch (err) {
    if (forced) throw err;
    console.warn(`${task}: GPU delegate unavailable, using CPU`, err);
    delegate = "CPU";
    detector = await make(delegate);
  }
  // Warm-up: the first detection compiles GPU shaders and can take several
  // seconds. Do it now, while the loading screen is up, not on the first video frame.
  const blank = await createImageBitmap(new ImageData(256, 256));
  detect(blank);
  return delegate;
}

function detect(bitmap: ImageBitmap) {
  const ts = Math.max(performance.now(), lastTs + 1); // VIDEO mode needs increasing timestamps
  lastTs = ts;
  const r = detector!.detectForVideo(bitmap, ts);
  bitmap.close();
  return r;
}

scope.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const msg = e.data;
  if (msg.type === "init") {
    try {
      scope.postMessage({ type: "ready", delegate: await init(msg.task, msg.base, msg.delegate) } satisfies WorkerOut);
    } catch (err) {
      scope.postMessage({ type: "error", message: (err as Error).message } satisfies WorkerOut);
    }
    return;
  }
  if (!detector) return msg.bitmap.close();
  const t0 = performance.now();
  const r = detect(msg.bitmap);
  // Copy to plain data (structured clone drops class instances' methods anyway).
  const result =
    "faceLandmarks" in r
      ? { faceLandmarks: r.faceLandmarks, faceBlendshapes: r.faceBlendshapes, facialTransformationMatrixes: r.facialTransformationMatrixes }
      : { landmarks: r.landmarks, worldLandmarks: r.worldLandmarks, handedness: r.handedness };
  scope.postMessage({ type: "result", result, ms: performance.now() - t0 } satisfies WorkerOut);
};
