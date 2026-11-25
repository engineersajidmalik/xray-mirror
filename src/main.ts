import { AmbientLight, Box3, DirectionalLight, Matrix4, MeshBasicMaterial, PerspectiveCamera, Plane, Scene, Vector2, Vector3, WebGLRenderer } from "three";
import { Anatomy, SHELL_LAYER } from "./anatomy";
import { CameraError, startCamera } from "./camera";
import { HandBones, type HandsInfo } from "./hands";
import { drawLabels, type ScreenLabel } from "./labels";
import { clipPlanes, shared } from "./materials";
import { type LayerId, loadSettings } from "./settings";
import { HeadPoseFilter, MEDIAPIPE_FOV_DEG, PoseFollower, Tracker } from "./tracking";
import { buildPanel } from "./ui";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const stage = $<HTMLDivElement>("stage");
const status = $<HTMLDivElement>("status");
const overlay = $<HTMLCanvasElement>("overlay");
const octx = overlay.getContext("2d")!;
const debugBox = $<HTMLPreElement>("debug");
const handsChip = $<HTMLDivElement>("hands-chip");

const settings = loadSettings();

/** Test/demo aid: ?lens=0.5,0.4 pins the X-ray lens (video coords) while no fingertip is seen. */
const LENS_PIN = new URLSearchParams(location.search).get("lens")?.split(",").map(Number) ?? null;
/** Render resolution: device pixel ratio capped at MAX_SCALE, lowered automatically when drawing gets slow. */
const MAX_SCALE = Math.min(window.devicePixelRatio, 1.5);
let renderScale = MAX_SCALE;

// ---------------------------------------------------------------- 3D setup
const renderer = new WebGLRenderer({ canvas: $<HTMLCanvasElement>("gl"), alpha: true, antialias: true, powerPreference: "high-performance" });
renderer.setClearColor(0x000000, 0);
renderer.localClippingEnabled = true;
renderer.autoClear = false;

const camera = new PerspectiveCamera(MEDIAPIPE_FOV_DEG, 16 / 9, 1, 10000);
camera.layers.enable(SHELL_LAYER);
/**
 * Solid look depth pre-pass: writes the nearest anatomy surface to the depth
 * buffer first, so the see-through solid look shows one layer per pixel
 * instead of stacking every inner surface.
 */
const depthPrepass = new MeshBasicMaterial({ colorWrite: false, clippingPlanes: clipPlanes });
const baseProjection = new Matrix4();
const headScene = new Scene();
const handScene = new Scene(); // drawn after the head with depth cleared: hands are always in front
const KEY_LIGHT = 3.2, FILL_LIGHT = 1.4; // solid look; scaled by the brightness slider
const lights = [headScene, handScene].map((scene) => {
  const key = new DirectionalLight(0xffffff, KEY_LIGHT);
  key.position.set(0.2, 0.4, 1);
  const fill = new AmbientLight(0xffffff, FILL_LIGHT);
  scene.add(key, fill);
  return { key, fill };
});

const anatomy = new Anatomy();
headScene.add(anatomy.head);
const hands = new HandBones();
handScene.add(hands.root);
const pose = new HeadPoseFilter();
const follower = new PoseFollower();
const tracker = new Tracker();

/** Live numbers for the tracking-data panel and the automated test. */
const stats = { frames: 0, fps: 0, last: 0, drawMs: 0, handResults: 0, handHits: 0, hands: { sides: [], indexTip: null } as HandsInfo };
const ema = (prev: number, v: number) => (prev ? 0.9 * prev + 0.1 * v : v);
declare global {
  interface Window {
    __xray?: { frames: number; summary: () => Record<string, unknown> };
  }
}
window.__xray = {
  get frames() {
    return stats.frames;
  },
  summary: () => ({
    delegate: tracker.delegate,
    tracked: pose.pose.tracked,
    fps: +stats.fps.toFixed(1),
    ms: { face: +tracker.face.ms.toFixed(1), hands: +tracker.hands.ms.toFixed(1), draw: +stats.drawMs.toFixed(1) },
    rates: { face: +tracker.face.rate.toFixed(1), hands: +tracker.hands.rate.toFixed(1) },
    fitScale: +pose.pose.fitScale.toFixed(3),
    fitShift: pose.pose.fitShift.map((v) => +v.toFixed(3)),
    turn: +pose.pose.turn.toFixed(1),
    nod: +pose.pose.nod.toFixed(1),
    tilt: +pose.pose.tilt.toFixed(1),
    jawOpen: +pose.pose.jawOpen.toFixed(2),
    distanceCm: pose.pose.distanceCm && +pose.pose.distanceCm.toFixed(0),
    layers: anatomy.visibleLayers(),
    labels: lastLabels,
    hands: stats.hands.sides,
    handHits: `${stats.handHits}/${stats.handResults}`,
    renderScale,
  }),
};
let lastLabels = 0;

// ------------------------------------------------------------- settings
function applySettings(): void {
  for (const id of ["skull", "brain", "muscles", "eyes", "head"] as const) {
    anatomy.setVisible(id, settings.layers[id]).catch((e) => showError(`Could not load the ${id} layer: ${e.message}`));
  }
  if (settings.layers.hands || settings.reveal === "lens") hands.load().catch((e) => showError(`Could not load hand bones: ${e.message}`));
  anatomy.ensureBackdrop().catch((e) => showError(`Could not load the head shell: ${e.message}`));
  anatomy.setLook(settings.look);
  hands.setLook(settings.look);
  anatomy.setFit(settings.fit);
  shared.uBrightness.value = settings.brightness;
  shared.uRealMe.value = settings.realMe;
  shared.uFeather.value = settings.feather;
  for (const l of lights) {
    l.key.intensity = KEY_LIGHT * settings.brightness;
    l.fill.intensity = FILL_LIGHT * settings.brightness;
  }
  debugBox.hidden = !settings.debug;
}

function showError(msg: string): void {
  status.hidden = false;
  status.className = "status";
  status.textContent = msg;
}

function setBanner(msg: string | null): void {
  status.hidden = !msg;
  status.className = "status banner";
  if (msg) status.textContent = msg;
}

// ------------------------------------------------------------ geometry
function resize(): void {
  stage.style.aspectRatio = `${video.videoWidth || 16} / ${video.videoHeight || 9}`;
  const { width, height } = stage.getBoundingClientRect();
  renderer.setPixelRatio(renderScale);
  renderer.setSize(width, height, false);
  overlay.width = Math.round(width * MAX_SCALE);
  overlay.height = Math.round(height * MAX_SCALE);
  octx.setTransform(MAX_SCALE, 0, 0, MAX_SCALE, 0, 0);
  camera.aspect = video.videoWidth / video.videoHeight || 16 / 9;
  camera.updateProjectionMatrix();
  baseProjection.copy(camera.projectionMatrix);
}

/** Applies the screen-fit correction (scale + shift in NDC) on top of the base projection. */
function applyScreenFit(): void {
  const [sx, sy] = pose.pose.fitShift;
  const s = pose.pose.fitScale;
  camera.projectionMatrix.multiplyMatrices(new Matrix4().set(s, 0, 0, sx, 0, s, 0, sy, 0, 0, 1, 0, 0, 0, 0, 1), baseProjection);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/** Reveal-mode cut planes, defined in head space (cm) and moved to camera space. */
function updateClipPlanes(): void {
  const b = -settings.cut; // +cut moves the boundary toward screen right (mirrored view)
  const local: Record<string, Plane | null> = {
    whole: null,
    lens: null,
    left: new Plane(new Vector3(1, 0, 0), -b), // subject's left = screen left in the mirror
    right: new Plane(new Vector3(-1, 0, 0), b),
    top: new Plane(new Vector3(0, 1, 0), -(3 + settings.cut)),
    lower: new Plane(new Vector3(0, -1, 0), -1.5 + settings.cut),
  };
  const plane = local[settings.reveal];
  clipPlanes.length = 0;
  if (plane) clipPlanes.push(plane.applyMatrix4(anatomy.head.matrixWorld));
}

/** Projects a world point to CSS pixels on the mirrored display. */
function toScreen(p: Vector3, w: number, h: number): [number, number] {
  const v = p.clone().project(camera);
  return [w - ((v.x + 1) / 2) * w, ((1 - v.y) / 2) * h];
}

/** The whole head (skin shell incl. the top of the head), canonical cm. */
const HEAD_BOX = new Box3(new Vector3(-9, -9.5, -17), new Vector3(9.5, 17, 8.5));

/** Projects the head box: sets the feather-mask ellipse and depth uniforms, returns label bounds (CSS px). */
function projectHead(w: number) {
  const buf = renderer.getDrawingBufferSize(new Vector2());
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 8; i++) {
    const c = new Vector3(i & 1 ? HEAD_BOX.max.x : HEAD_BOX.min.x, i & 2 ? HEAD_BOX.max.y : HEAD_BOX.min.y, i & 4 ? HEAD_BOX.max.z : HEAD_BOX.min.z);
    const v = c.applyMatrix4(anatomy.fit.matrixWorld).project(camera);
    minX = Math.min(minX, v.x);
    maxX = Math.max(maxX, v.x);
    minY = Math.min(minY, v.y);
    maxY = Math.max(maxY, v.y);
  }
  // Ellipse in drawing-buffer pixels (unmirrored, origin bottom-left like gl_FragCoord).
  shared.uHeadCenter.value.set(((minX + maxX) / 4 + 0.5) * buf.x, ((minY + maxY) / 4 + 0.5) * buf.y);
  shared.uHeadAxes.value.set(Math.max(1, ((maxX - minX) / 4) * buf.x), Math.max(1, ((maxY - minY) / 4) * buf.y));
  const center = HEAD_BOX.getCenter(new Vector3()).applyMatrix4(anatomy.fit.matrixWorld);
  shared.uHeadDepth.value = center.z; // the camera sits at the origin, so world z = view z
  // Label columns on the mirrored display.
  const left = w - ((maxX + 1) / 2) * w, right = w - ((minX + 1) / 2) * w;
  return { left, right, centerX: (left + right) / 2 };
}

function renderLabels(head: ReturnType<typeof projectHead>, w: number, h: number): void {
  octx.clearRect(0, 0, w, h);
  lastLabels = 0;
  if (!settings.labels || !pose.pose.tracked) return;
  const visible = new Set(anatomy.visibleLayers());
  const lens = shared.uLensOn.value > 0.5;
  const dpr = renderer.getPixelRatio();
  const items: ScreenLabel[] = [];
  for (const a of anatomy.labels) {
    if (!visible.has(a.layer)) continue;
    const world = a.local.clone().applyMatrix4(a.object.matrixWorld);
    if (clipPlanes.some((pl) => pl.distanceToPoint(world) < 0)) continue;
    const [x, y] = toScreen(world, w, h);
    if (lens) {
      // Lens centre is in (unmirrored) drawing-buffer pixels.
      const cx = w - shared.uLensCenter.value.x / dpr, cy = h - shared.uLensCenter.value.y / dpr;
      if (Math.hypot(x - cx, y - cy) > shared.uLensRadius.value / dpr) continue;
    }
    items.push({ text: a.text, x, y });
  }
  // Fade the labels out as the head turns far to the side.
  const turn = Math.abs(pose.pose.turn);
  const opacity = 1 - Math.min(1, Math.max(0, (turn - 30) / 25));
  lastLabels = drawLabels(octx, items, head, w, h, opacity);
}

// ---------------------------------------------------------------- loop
function frame(): void {
  const t = performance.now() / 1000;
  const prevT = stats.last;
  if (stats.last) stats.fps = stats.fps ? 0.9 * stats.fps + 0.1 / (t - stats.last) : 1 / (t - stats.last);
  stats.last = t;
  stats.frames++;

  const lensMode = settings.reveal === "lens";
  const t1 = performance.now();
  // Detection runs in workers; each display frame uses the newest results available.
  const wantHands = settings.layers.hands || lensMode;
  tracker.submit(video, wantHands);
  const face = tracker.face.take();
  if (face) {
    pose.update(face, t, video.videoWidth, video.videoHeight);
    pose.updateScreenFit(baseProjection, camera.aspect, t);
  }
  const p = pose.pose;
  anatomy.head.visible = p.tracked;
  if (p.tracked) {
    follower.follow(p, stats.last ? t - prevT : 0);
    anatomy.head.matrix.copy(follower.matrix);
    anatomy.head.updateMatrixWorld(true);
    anatomy.setJawOpen(follower.jawOpen);
  } else {
    follower.reset();
  }
  applyScreenFit();
  updateClipPlanes();
  shared.uTime.value = t;
  const { width: cssW, height: cssH } = stage.getBoundingClientRect();
  const head = projectHead(cssW);

  const tanY = Math.tan(((MEDIAPIPE_FOV_DEG / 2) * Math.PI) / 180);
  const handResult = wantHands ? tracker.hands.take() : null;
  if (handResult || !wantHands) {
    stats.hands = hands.update(handResult, tanY, camera.aspect, settings.layers.hands, t);
    tracker.noteHands(stats.hands.sides.length);
    if (handResult) {
      stats.handResults++;
      if (stats.hands.sides.length) stats.handHits++;
    }
  }
  const buf = renderer.getDrawingBufferSize(new Vector2());
  shared.uLensOn.value = lensMode ? 1 : 0;
  const tip = stats.hands.indexTip ?? (LENS_PIN ? { x: LENS_PIN[0], y: LENS_PIN[1] } : null);
  if (lensMode && tip) shared.uLensCenter.value.set(tip.x * buf.x, (1 - tip.y) * buf.y);
  shared.uLensRadius.value = lensMode && tip ? settings.lensSize * buf.y : 0;

  renderer.clear();
  if (settings.look === "solid") {
    camera.layers.disable(SHELL_LAYER);
    headScene.overrideMaterial = depthPrepass;
    renderer.render(headScene, camera);
    headScene.overrideMaterial = null;
    camera.layers.enable(SHELL_LAYER);
  }
  renderer.render(headScene, camera);
  renderer.clearDepth();
  renderer.render(handScene, camera);
  renderLabels(head, cssW, cssH);
  stats.drawMs = ema(stats.drawMs, performance.now() - t1);
  adaptRenderScale(t);

  handsChip.hidden = !(settings.layers.hands || lensMode);
  handsChip.textContent = `hands: ${stats.hands.sides.length ? stats.hands.sides.join(" / ") : "none"}`;
  if (!p.tracked) setBanner("Show your face to the camera");
  else if (lensMode && !tip) setBanner("Raise your index finger to move the X-ray lens");
  else setBanner(null);
  if (settings.debug && stats.frames % 6 === 0) renderDebug();
}

/**
 * Every 2 s: if a frame takes too long to draw, lower the render resolution
 * (down to 0.6x); raise it again when there is headroom.
 */
let scaleCheckAt = 0;
function adaptRenderScale(t: number): void {
  if (t < scaleCheckAt) return;
  scaleCheckAt = t + 2;
  const next = stats.drawMs > 14 ? renderScale - 0.2 : stats.drawMs < 6 ? renderScale + 0.1 : renderScale;
  const clamped = Math.min(MAX_SCALE, Math.max(0.6, +next.toFixed(2)));
  if (clamped !== renderScale) {
    renderScale = clamped;
    resize();
  }
}

function renderDebug(): void {
  const p = pose.pose;
  const tip = stats.hands.indexTip;
  debugBox.textContent = [
    `face        ${p.tracked ? `tracked, ${p.landmarks?.length ?? 0} points` : "not tracked"}`,
    `distance    ${p.distanceCm ? `~${p.distanceCm.toFixed(0)} cm (iris estimate)` : "-"}`,
    `turn/nod/tilt ${p.turn.toFixed(0)}° / ${p.nod.toFixed(0)}° / ${p.tilt.toFixed(0)}°`,
    `jaw open    ${p.jawOpen.toFixed(2)}`,
    `screen fit  scale ${p.fitScale.toFixed(3)}, shift ${p.fitShift.map((v) => v.toFixed(3)).join(", ")}`,
    `hands       ${stats.hands.sides.join(", ") || "none"}`,
    `index tip   ${tip ? `${tip.x.toFixed(3)}, ${tip.y.toFixed(3)}` : "-"}`,
    `layers      ${(Object.keys(settings.layers) as LayerId[]).filter((k) => settings.layers[k]).join(", ")}`,
    `speed       ${stats.fps.toFixed(1)} frames/s (${tracker.delegate})`,
    `detection   face ${tracker.face.rate.toFixed(0)}/s (${tracker.face.ms.toFixed(0)} ms), hands ${tracker.hands.rate.toFixed(0)}/s (${tracker.hands.ms.toFixed(0)} ms)`,
    `draw        ${stats.drawMs.toFixed(1)} ms/frame at ${Math.round(renderScale * 100)}% resolution`,
  ].join("\n");
}

function loop(): void {
  try {
    frame();
  } catch (err) {
    console.error(err);
  }
  if ("requestVideoFrameCallback" in video) video.requestVideoFrameCallback(loop);
  else requestAnimationFrame(loop);
}

async function start(): Promise<void> {
  buildPanel($("panel"), settings, applySettings);
  try {
    status.textContent = "Starting camera ...";
    await startCamera(video);
    resize();
    new ResizeObserver(resize).observe(stage);
    await tracker.init((msg) => (status.textContent = msg));
    status.textContent = "Loading anatomy ...";
    applySettings();
    await anatomy.ensureBackdrop();
    loop();
  } catch (err) {
    showError(err instanceof CameraError ? err.message : `Something went wrong: ${(err as Error).message}`);
    console.error(err);
  }
}

start();
