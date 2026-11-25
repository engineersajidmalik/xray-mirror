// End-to-end check: serves the app with Vite, opens it in the installed
// Chrome with a fake webcam that plays test-media/face.y4m, then reports
// console errors, tracking state and FPS, and saves screenshots.
//
// Usage: node tools/e2e.mjs [outDir] [settingsJson] [seconds] [pagePath] [actionJs]
//   actionJs runs in the page after the first frame; its return value is printed.
//   settingsJson is merged into the saved settings before the page loads,
//   e.g. '{"look":"solid","reveal":"left"}'.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { createServer, preview } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(process.argv[2] ?? join(root, "test-media/shots"));
const overrides = JSON.parse(process.argv[3] ?? "{}");
const seconds = Number(process.argv[4] ?? 8);
// Page path without a leading slash (Git Bash rewrites "/x" arguments into Windows paths).
const pagePath = `/${(process.argv[5] ?? "").replace(/^\/+/, "")}`;
const action = process.argv[6] ?? "";
// E2E_VIEW=1366x768 sets the browser window size.
const VIEW = (process.env.E2E_VIEW ?? "1400x900").split("x").map(Number);
const video = join(root, "test-media/face.y4m");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find(existsSync);

if (!existsSync(video)) throw new Error("Missing test-media/face.y4m (run tools/make-test-video.py first)");
if (!CHROME) throw new Error("Chrome or Edge not found");
mkdirSync(outDir, { recursive: true });

// E2E_PREVIEW=1 tests the production build in dist/ (run `npm run build` first).
const server = process.env.E2E_PREVIEW
  ? await preview({ root, logLevel: "error", preview: { port: 5174, strictPort: true } })
  : await (await createServer({ root, logLevel: "error", server: { port: 5174, strictPort: true } })).listen();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`,
    "--use-angle=d3d11", // real GPU when available, so the FPS figure is meaningful
    "--ignore-gpu-blocklist",
    "--enable-unsafe-swiftshader",
    `--window-size=${VIEW[0]},${VIEW[1]}`,
  ],
  defaultViewport: { width: VIEW[0], height: VIEW[1] },
});
const errors = [];
try {
  const page = await browser.newPage();
  // MediaPipe logs a harmless "Created TensorFlow Lite XNNPACK delegate" info line via console.error.
  page.on("console", (m) => (m.type() === "error" || m.type() === "warning") && !m.text().includes("XNNPACK") && errors.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.evaluateOnNewDocument((o) => {
    const key = "xray-mirror-settings-v2";
    localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) ?? "{}"), ...o }));
  }, overrides);
  // E2E_CPU_THROTTLE=6 slows the page's CPU 6x (checks the automatic quality reduction).
  if (process.env.E2E_CPU_THROTTLE) await page.emulateCPUThrottling(Number(process.env.E2E_CPU_THROTTLE));
  await page.goto(`http://localhost:5174${pagePath}`, { waitUntil: "load" });
  const t0 = Date.now();
  await page.waitForFunction(() => window.__xray?.frames > 0, { timeout: 90000 });
  console.log(`first frame after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (action) console.log("action:", JSON.stringify(await page.evaluate(action)));
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, (seconds * 1000) / 3));
    await page.screenshot({ path: join(outDir, `shot${i}.png`) });
  }
  const state = await page.evaluate(() => window.__xray.summary());
  console.log("state:", JSON.stringify(state));
} finally {
  console.log(errors.length ? `console problems:\n  ${errors.join("\n  ")}` : "no console errors");
  await browser.close();
  await server.close();
}
