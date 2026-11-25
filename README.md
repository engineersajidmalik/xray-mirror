<div align="center">

# 🩻 X-Ray Mirror

**Real-time 3D anatomical X-ray overlay on your webcam, running entirely in the browser.**

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![three.js](https://img.shields.io/badge/three.js-000000?style=flat-square&logo=threedotjs&logoColor=white)
![MediaPipe](https://img.shields.io/badge/MediaPipe-0097A7?style=flat-square&logo=google&logoColor=white)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white)
![License](https://img.shields.io/badge/code-MIT-green?style=flat-square)

<!-- ADD DEMO: record a 10-second screen capture, save as docs/demo.gif, then uncomment: -->
<!-- <img src="docs/demo.gif" alt="X-Ray Mirror demo" width="720"/> -->

</div>

A single-page web app that overlays a 3D anatomical X-ray (skull, brain, facial muscles, eyes,
head outline) on your head, and hand bones on your hands, using your webcam. Video never leaves
your computer.

> The anatomy is a real 3D dataset of one adult, scaled and pinned to your head. It shows
> where structures typically sit, not a scan of you, and it is not a medical tool.

## Highlights

- **Face and hand tracking** with MediaPipe running in two Web Workers (GPU delegate, CPU fallback)
- **Stable motion:** One-Euro filtering plus a display-rate follower for smooth overlays
- **Adaptive performance:** render resolution drops automatically when frames take over 14 ms
- **Mixed reality controls:** X-ray lens that follows your fingertip, reveal modes, edge feather
- **Reproducible asset pipeline:** `npm run anatomy` builds GLB layers from BodyParts3D via HTTP range requests
- **End-to-end tests:** headless Chrome plays a video as a fake webcam and reports FPS and errors

## Setup

Requires a recent Node.js (tested with 24) and a recent Chrome or Edge.

```
npm install
npm run models     # MediaPipe face/hand models + WASM runtime -> public/ (about 26 MB)
npm run anatomy    # anatomy layers -> public/anatomy/*.glb (downloads about 17 MB of meshes)
npm run dev        # open http://localhost:5173 and allow the camera
```

`npm run models` and `npm run anatomy` only need to run once. After that, the app works
without any internet connection. For a static build, run `npm run build`; the output in
`dist/` can be served by any static web server (camera access needs `localhost` or `https`).

### Where the assets come from

| File | Source | Licence |
|---|---|---|
| `public/models/face_landmarker.task` | [MediaPipe Face Landmarker](https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task) | Apache 2.0 |
| `public/models/hand_landmarker.task` | [MediaPipe Hand Landmarker](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task) | Apache 2.0 |
| `public/mediapipe/*` | copied from `node_modules/@mediapipe/tasks-vision/wasm` | Apache 2.0 |
| `public/anatomy/*.glb` | built from [BodyParts3D](https://dbarchive.biosciencedbc.jp/en/bodyparts3d/) (`isa_BP3D_4.0_obj_99.zip`) | CC BY-SA 2.1 JP |
| `public/anatomy/muscles.glb` | generated from the MediaPipe canonical face model | Apache 2.0 |

`tools/build-anatomy.mjs` reads the BodyParts3D archive with HTTP range requests, so only
the needed meshes are downloaded (cached in `anatomy-src/`). It converts them to MediaPipe's
canonical face space (cm) and fits them to it, matching eye centres, nasion and chin. Then it
simplifies the meshes and writes one GLB per layer. BodyParts3D contains **no facial
muscles**, so that layer is generated from the face mesh: frontalis, orbicularis oculi/oris,
zygomaticus major, masseter and temporalis, as surface patches 3.5 mm under the skin.

## License

Code is released under the [MIT License](LICENSE). Anatomy data is derived from BodyParts3D
(CC BY-SA 2.1 JP), so the generated `public/anatomy/*.glb` files stay under that licence.

**Credits:** Anatomy: BodyParts3D, © The Database Center for Life Science, licensed under
CC Attribution-Share Alike 2.1 Japan (modified: parts selected, converted, fitted,
simplified). Tracking: Google MediaPipe. 3D: three.js.

## Using it

- **Layers:** presets (Skull, Brain, Muscles, Everything; Everything is the default) or
  individual checkboxes; *Show labels*. Labels fade out when you turn your head far to the side.
- **Look:** X-ray (additive fresnel glow: bright bone edges, dark translucent centres, depth
  cue, faint scan shimmer; pink brain, salmon muscles, thin blue head outline) or Solid
  (lit bone that turns see-through as *Real me showing through* rises); brightness.
- **Mixed reality:** *Real me showing through* (how much of the camera shows under the
  overlay), *Edge feather* (soft silhouette edge), and *Reveal*: whole head, left/right
  half, top of the head, lower face (with a *Cut position*), or **X-ray lens**, a circle
  that follows your index fingertip (*Lens size*).
- **Fit to my head:** overall size (default 117%), width/height/depth, and offsets in cm. Tip: pick
  *Solid*, set *Real me showing through* to about half, then line the skull up with your face.
- **Show tracking data:** face, distance, turn/nod/tilt, jaw open, screen fit, hands,
  fingertip, layers, frame rate, and detection rate/time.

All settings are saved in the browser (localStorage). Add `?delegate=CPU` to the URL to
force MediaPipe onto the CPU (the default is GPU, falling back to CPU). Add `?lens=0.5,0.4`
to pin the X-ray lens at that video position while no fingertip is visible (for demos and tests).

## How it works

- **Head pose:** MediaPipe's facial transformation matrix maps the canonical face (cm) to
  camera space for a virtual camera with a 63° vertical field of view. The three.js camera
  uses the same field of view, so the anatomy lands on the face. A per-frame "screen fit"
  compares projected rigid face points with the detected landmarks and corrects any
  remaining scale or shift.
- **Smoothing:** One-Euro filters on position, rotation, scale and jaw. A display-rate
  follower glides between detections, so motion stays smooth at the camera's frame rate.
- **Jaw:** the mandible rotates about the jaw joints, driven by the `jawOpen` blendshape.
- **Distance:** from the iris size (11.7 mm average diameter), assuming a 60° horizontal webcam field of view.
- **Hands:** every landmark is placed on its pixel's viewing ray. Depth comes from the
  palm's metric size (world landmarks) against its image size, and relative depth from the
  world landmarks. The 21 points are One-Euro smoothed. Each bone follows its landmark
  segment (wrist->MCP->PIP->DIP->TIP): length from the segment, thickness from the whole
  hand's size (wrist -> middle knuckle), orientation from the palm plane. Hands render in a
  second pass, always in front of the head.
- **Mixed reality:** a dark film on the head shell lets the camera show through by *Real me*;
  *Edge feather* fades the whole overlay with a soft elliptical mask around the head. The
  solid look uses a depth pre-pass, so each pixel shows one see-through bone layer.
- **Performance:** face and hand detection run in two Web Workers (GPU delegate) on frames
  downscaled to 640 px wide. Rendering never waits for detection. Hand detection drops to
  4 checks per second while no hand is in view. The first start compiles GPU shaders
  during the loading screen. If drawing a frame takes over 14 ms, the render resolution
  drops automatically (to 60% at most) and recovers when there is headroom.

## Tests

```
python tools/make-test-video.py <portrait.jpg>   # once: test-media/face.y4m fake webcam
node tools/e2e.mjs test-media/shots '{"reveal":"left"}' 8   # dev server + headless Chrome
E2E_PREVIEW=1 node tools/e2e.mjs                 # same, against the production build
node tools/e2e.mjs test-media/hand '{}' 1 tools/hand-test/index.html   # hand-rig check
```

`e2e.mjs` plays the video as a fake camera in your installed Chrome. It prints tracking
state, frame rate, detection rates and console errors, and saves screenshots. A 5th argument
is a page path (e.g. `?lens=0.5,0.45`), a 6th is JavaScript to run in the page (e.g. click
the preset buttons). `E2E_VIEW=1366x768` sets the window size and `E2E_CPU_THROTTLE=6`
slows the CPU.

## Limits

- One person's anatomy, scaled to you: it will not match every face exactly (use *Fit to my head*).
- Facial muscles are generated approximations; BodyParts3D has none.
- Hand bones are approximate: each bone follows its landmark segment; joint twist is not modelled.
- On a laptop running on battery, face detection runs at about 10 per second on an Intel
  UHD 620 (display stays at about 30 FPS). On mains power it is faster.
