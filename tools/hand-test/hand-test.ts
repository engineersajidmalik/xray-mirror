// Test page for the hand rig: synthetic landmarks of an open right hand
// (palm toward the camera, unmirrored image) -> HandBones -> render, with the
// landmark points drawn on top so bone/landmark alignment can be checked.
import type { HandLandmarkerResult } from "@mediapipe/tasks-vision";
import { AmbientLight, DirectionalLight, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import { HandBones } from "../../src/hands";

const W = 960, H = 540, FOV = 63;
const renderer = new WebGLRenderer({ canvas: document.getElementById("gl") as HTMLCanvasElement, antialias: true });
const camera = new PerspectiveCamera(FOV, W / H, 1, 1000);
const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6), new DirectionalLight(0xffffff, 2));
const hands = new HandBones();
scene.add(hands.root);

// Hand in cm, x = image right, y = up; subject's right hand, palm to camera,
// so the thumb points toward image right (the subject's left).
const cm: [number, number][] = [
  [0, 0], [2.2, 1.8], [3.6, 3.8], [4.6, 5.6], [5.4, 7.2], // thumb
  [2.4, 8.5], [2.8, 12.2], [3.0, 14.6], [3.2, 16.6], // index
  [0.3, 9.0], [0.3, 13.2], [0.3, 15.9], [0.3, 18.0], // middle
  [-1.8, 8.6], [-2.1, 12.4], [-2.3, 14.9], [-2.4, 16.9], // ring
  [-3.6, 7.6], [-4.3, 10.6], [-4.7, 12.4], [-5.0, 14.0], // little
];
const depth = 45, tanY = Math.tan((FOV / 2) * Math.PI / 180), wrist = [-4, -9];
const landmarks = cm.map(([x, y]) => ({
  x: 0.5 + (wrist[0] + x) / (depth * tanY * (W / H)) / 2,
  y: 0.5 - (wrist[1] + y) / (depth * tanY) / 2,
  z: 0, visibility: 1,
}));
const worldLandmarks = cm.map(([x, y]) => ({ x: (x - 0.3) / 100, y: -(y - 8) / 100, z: 0, visibility: 1 }));
const result = {
  landmarks: [landmarks], worldLandmarks: [worldLandmarks],
  handedness: [[{ categoryName: "Left", score: 1, index: 0, displayName: "" }]], // MediaPipe's label for a subject's right hand
  handednesses: [],
} as unknown as HandLandmarkerResult;

hands.load().then(() => {
  const info = hands.update(result, tanY, W / H, true, 0);
  renderer.render(scene, camera);
  const ctx = (document.getElementById("pts") as HTMLCanvasElement).getContext("2d")!;
  ctx.fillStyle = "#ff3b6b";
  for (const l of landmarks) { ctx.beginPath(); ctx.arc(l.x * W, l.y * H, 3, 0, 7); ctx.fill(); }
  (window as unknown as { __xray: unknown }).__xray = { frames: 1, summary: () => info };
});
