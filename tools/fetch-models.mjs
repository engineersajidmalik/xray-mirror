// Downloads the MediaPipe models and copies the MediaPipe WASM runtime into
// public/, so the app runs fully from this machine (no CDN at runtime).
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODELS = {
  "face_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  "hand_landmarker.task":
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
};

mkdirSync(join(root, "public/models"), { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const dest = join(root, "public/models", name);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`ok   ${name} (already present)`);
    continue;
  }
  console.log(`get  ${name}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Download failed (${res.status}). Get it manually from\n  ${url}\nand save it as\n  ${dest}`);
    process.exit(1);
  }
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const wasmSrc = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmDst = join(root, "public/mediapipe");
mkdirSync(wasmDst, { recursive: true });
// Only the ES-module build is used (the detectors run in module web workers).
for (const f of readdirSync(wasmDst)) rmSync(join(wasmDst, f));
for (const f of readdirSync(wasmSrc).filter((f) => f.includes("module"))) copyFileSync(join(wasmSrc, f), join(wasmDst, f));
console.log("ok   MediaPipe WASM runtime copied to public/mediapipe");
