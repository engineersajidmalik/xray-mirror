// Builds the anatomy layers (public/anatomy/*.glb) from BodyParts3D and the
// MediaPipe canonical face model.
//
//  - Only the needed BodyParts3D meshes are fetched (HTTP range requests into
//    the official ZIP) and cached in anatomy-src/obj/.
//  - Head layers are converted to MediaPipe's canonical face space (cm, y up,
//    z toward the camera) and fitted to it with a similarity transform that
//    matches eye centres, nasion and menton. At runtime the face
//    transformation matrix then places them on the user's head directly.
//  - Hand bones are stored per bone in a local frame (origin at the proximal
//    joint, +Y toward the distal joint, +X toward the thumb side), ready to be
//    aligned with the hand landmark segments.
//  - The facial-muscle layer is generated from the canonical face mesh, since
//    BodyParts3D contains no facial muscles.
//
// Usage: npm run anatomy
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Document, NodeIO } from "@gltf-transform/core";
import { MeshoptSimplifier } from "meshoptimizer";
import { readZipEntry, readZipIndex } from "./remote-zip.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(root, "anatomy-src");
const OUT = join(root, "public/anatomy");
const BP3D = "https://dbarchive.biosciencedbc.jp/data/bodyparts3d/LATEST";
const ZIP_URL = `${BP3D}/isa_BP3D_4.0_obj_99.zip`;
const CANONICAL_URL =
  "https://raw.githubusercontent.com/google-ai-edge/mediapipe/master/mediapipe/modules/face_geometry/data/canonical_face_model.obj";

// ---------------------------------------------------------------- small math
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => scale(a, 1 / (norm(a) || 1));
const lerp = (a, b, t) => add(a, scale(sub(b, a), t));
const mean = (pts) => scale(pts.reduce(add, [0, 0, 0]), 1 / pts.length);

/** 3x3 symmetric eigen-decomposition (Jacobi). Returns {values, vectors(columns)}. */
function eigSym(m) {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/** Principal axis (largest variance) of a point cloud. */
function principalAxis(pts) {
  const c = mean(pts);
  const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += d[i] * d[j];
  }
  const { values, vectors } = eigSym(cov);
  const k = values.indexOf(Math.max(...values));
  return [vectors[0][k], vectors[1][k], vectors[2][k]];
}

/** Similarity transform (Umeyama) mapping src points onto dst points. */
function similarity(src, dst) {
  const cs = mean(src), cd = mean(dst);
  const H = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let varS = 0;
  src.forEach((s, n) => {
    const a = sub(s, cs), b = sub(dst[n], cd);
    varS += dot(a, a);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) H[i][j] += a[i] * b[j];
  });
  // Rotation from the polar decomposition of H via eigen-decomposition of H^T H.
  const HtH = [0, 1, 2].map((i) => [0, 1, 2].map((j) => H[0][i] * H[0][j] + H[1][i] * H[1][j] + H[2][i] * H[2][j]));
  const { values, vectors: V } = eigSym(HtH);
  const inv = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let k = 0; k < 3; k++) {
    const w = 1 / Math.sqrt(Math.max(values[k], 1e-12));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) inv[i][j] += w * V[i][k] * V[j][k];
  }
  // R = (H (H^T H)^-1/2)^T  maps src offsets to dst offsets.
  const U = [0, 1, 2].map((i) => [0, 1, 2].map((j) => H[i][0] * inv[0][j] + H[i][1] * inv[1][j] + H[i][2] * inv[2][j]));
  const R = [0, 1, 2].map((i) => [0, 1, 2].map((j) => U[j][i]));
  const trace = [0, 1, 2].reduce((t, k) => t + Math.sqrt(Math.max(values[k], 0)), 0);
  const s = trace / varS;
  const apply = (p) => {
    const d = sub(p, cs);
    return add(cd, scale([dot(R[0], d), dot(R[1], d), dot(R[2], d)], s));
  };
  return { apply, scale: s };
}

// ------------------------------------------------------------- data access
function readLines(path) {
  return readFileSync(path, "utf8").split(/\r?\n/);
}

async function download(url, path) {
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  writeFileSync(path, Buffer.from(await res.arrayBuffer()));
}

/** concept name -> Set of element file ids, and element -> most specific concept. */
function loadConcepts(path) {
  const byConcept = new Map(), byElement = new Map();
  for (const line of readLines(path).slice(1)) {
    const [, name, fj] = line.split("\t");
    if (!fj) continue;
    if (!byConcept.has(name)) byConcept.set(name, new Set());
    byConcept.get(name).add(fj);
    if (!byElement.has(fj)) byElement.set(fj, new Set());
    byElement.get(fj).add(name);
  }
  const specific = (fj) => [...byElement.get(fj)].sort((a, b) => byConcept.get(a).size - byConcept.get(b).size)[0];
  const elements = (name) => {
    const set = byConcept.get(name);
    if (!set) throw new Error(`BodyParts3D concept not found: "${name}"`);
    return [...set];
  };
  return { elements, specific };
}

/** Parses an OBJ into {positions: [[x,y,z]], faces: [[a,b,c]]} (0-based, triangulated). */
function parseObj(text) {
  const positions = [], faces = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.trim().split(/\s+/).map(Number);
      positions.push([x, y, z]);
    } else if (line.startsWith("f ")) {
      const idx = line.trim().split(/\s+/).slice(1).map((t) => parseInt(t, 10) - 1);
      for (let k = 1; k + 1 < idx.length; k++) faces.push([idx[0], idx[k], idx[k + 1]]);
    }
  }
  return { positions, faces };
}

/** BodyParts3D (mm; +x left, +y posterior, +z superior) -> canonical axes (cm; y up, z anterior). */
const bp3dToCanonical = ([x, y, z]) => [x / 10, z / 10, -y / 10];

class MeshCache {
  constructor(index, dir) {
    this.index = index;
    this.dir = dir;
    this.memo = new Map();
  }
  async get(fj) {
    if (this.memo.has(fj)) return this.memo.get(fj);
    const path = join(this.dir, `${fj}.obj`);
    if (!existsSync(path)) {
      const entry = this.index.get(`isa_BP3D_4.0_obj_99/${fj}.obj`);
      if (!entry) throw new Error(`${fj}.obj is not in the BodyParts3D archive`);
      writeFileSync(path, await readZipEntry(ZIP_URL, entry));
    }
    const mesh = parseObj(readFileSync(path, "utf8"));
    mesh.positions = mesh.positions.map(bp3dToCanonical);
    this.memo.set(fj, mesh);
    return mesh;
  }
}

// ------------------------------------------------------------ mesh helpers
function merge(meshes) {
  const positions = [], faces = [];
  for (const m of meshes) {
    const base = positions.length;
    positions.push(...m.positions);
    for (const f of m.faces) faces.push([f[0] + base, f[1] + base, f[2] + base]);
  }
  return { positions, faces };
}

const transform = (mesh, fn) => ({ positions: mesh.positions.map(fn), faces: mesh.faces });

/** Simplifies to at most `maxTris` triangles, drops unused vertices, computes smooth normals. */
function finalize(mesh, maxTris) {
  const pos = new Float32Array(mesh.positions.flat());
  let idx = new Uint32Array(mesh.faces.flat());
  if (mesh.faces.length > maxTris) {
    // Weld coincident vertices first so the simplifier sees one connected surface.
    const remap = MeshoptSimplifier.generatePositionRemap(pos, 3);
    idx = idx.map((i) => remap[i]);
    [idx] = MeshoptSimplifier.simplify(idx, pos, 3, maxTris * 3, 0.05, ["Prune"]);
  }
  const used = new Map(), outPos = [];
  const outIdx = new Uint32Array(idx.length);
  idx.forEach((i, n) => {
    if (!used.has(i)) {
      used.set(i, used.size);
      outPos.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    }
    outIdx[n] = used.get(i);
  });
  const P = new Float32Array(outPos);
  const N = new Float32Array(P.length);
  for (let t = 0; t < outIdx.length; t += 3) {
    const [a, b, c] = [outIdx[t], outIdx[t + 1], outIdx[t + 2]];
    const pa = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const n = cross(sub([P[b * 3], P[b * 3 + 1], P[b * 3 + 2]], pa), sub([P[c * 3], P[c * 3 + 1], P[c * 3 + 2]], pa));
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) N[v * 3 + k] += n[k];
  }
  for (let v = 0; v < N.length; v += 3) {
    const l = Math.hypot(N[v], N[v + 1], N[v + 2]) || 1;
    N[v] /= l; N[v + 1] /= l; N[v + 2] /= l;
  }
  return { positions: P, normals: N, indices: outIdx, triangles: outIdx.length / 3 };
}

async function writeGlb(name, parts) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene(name);
  let tris = 0;
  for (const part of parts) {
    const m = part.mesh;
    const indices = m.positions.length / 3 < 65535 ? new Uint16Array(m.indices) : m.indices;
    const prim = doc
      .createPrimitive()
      .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(m.positions).setBuffer(buffer))
      .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(m.normals).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType("SCALAR").setArray(indices).setBuffer(buffer));
    const node = doc.createNode(part.name).setMesh(doc.createMesh(part.name).addPrimitive(prim));
    node.setExtras(part.extras || {});
    scene.addChild(node);
    tris += m.triangles;
  }
  doc.getRoot().setDefaultScene(scene);
  const glb = await new NodeIO().writeBinary(doc);
  writeFileSync(join(OUT, `${name}.glb`), glb);
  console.log(`  ${name}.glb  ${parts.length} parts, ${tris} triangles, ${(glb.length / 1024).toFixed(0)} KB`);
}

// --------------------------------------------------------- canonical face
async function loadCanonical() {
  const path = join(SRC, "mediapipe/canonical_face_model.obj");
  await download(CANONICAL_URL, path);
  const { positions, faces } = parseObj(readFileSync(path, "utf8"));
  return { positions, faces };
}

// ---------------------------------------------------------------- layers
// Label anchor rules: the anchor is the vertex maximising the rule (canonical axes:
// +x = subject's left, +y = up, +z = toward the camera). null = no label (inner bones).
const ANCHOR = {
  frontTop: (p) => p[2] + 0.7 * p[1],
  top: (p) => p[1] + 0.3 * p[0],
  left: (p) => p[0],
  right: (p) => -p[0],
  front: (p) => p[2],
  frontLow: (p) => p[2] - 0.5 * p[1],
  leftLow: (p) => p[0] - 0.4 * p[1],
  rightLow: (p) => -p[0] - 0.4 * p[1],
  backLow: (p) => -p[2] - 0.6 * p[1],
  low: (p) => -p[1],
};
const anchorBy = (m, rule) => m.positions.reduce((b, p) => (ANCHOR[rule](p) > ANCHOR[rule](b) ? p : b));

const SKULL_PARTS = [
  ["Frontal bone", ["frontal bone"], 7000, "frontTop"],
  ["Parietal bone", ["parietal bone"], 7000, "top"],
  ["Occipital bone", ["occipital bone"], 4500, "backLow"],
  ["Temporal bone", ["temporal bone"], 6000, "right"],
  ["Sphenoid bone", ["sphenoid bone"], 4000, "left"],
  ["Ethmoid bone", ["ethmoid"], 1500, null],
  ["Zygomatic bone", ["zygomatic bone"], 2500, "left"],
  ["Maxilla", ["maxilla"], 5000, "rightLow"],
  ["Nasal bone", ["nasal bone"], 600, "front"],
  ["Lacrimal bone", ["lacrimal bone"], 400, null],
  ["Palatine bone", ["palatine bone"], 800, null],
  ["Vomer", ["vomer"], 500, null],
];

const BRAIN_LOBES = {
  "Frontal lobe": ["superior frontal gyrus", "middle frontal gyrus", "inferior frontal gyrus", "precentral gyrus", "orbital gyrus"],
  "Parietal lobe": ["postcentral gyrus", "superior parietal lobule", "supramarginal gyrus", "angular gyrus"],
  "Temporal lobe": ["superior temporal gyrus", "middle temporal gyrus", "inferior temporal gyrus", "fusiform gyrus", "parahippocampal gyrus"],
  "Occipital lobe": ["occipital lobe"],
  "Insula and cingulate": ["insula", "cingulate gyrus"],
  Cerebellum: ["cerebell"],
  Brainstem: ["midbrain", "pons", "medulla oblongata", "colliculus", "hindbrain", "encephalon", "cardinal segment of brain"],
};
const BRAIN_ANCHOR = { "Frontal lobe": "frontTop", "Parietal lobe": "top", "Temporal lobe": "left", "Occipital lobe": "backLow", "Insula and cingulate": null, Cerebellum: "rightLow", Brainstem: "low" };
const BRAIN_BUDGET = { "Frontal lobe": 14000, "Parietal lobe": 9000, "Temporal lobe": 9000, "Occipital lobe": 5000, "Insula and cingulate": 3000, Cerebellum: 7000, Brainstem: 2500 };

const FINGERS = ["thumb", "index finger", "middle finger", "ring finger", "little finger"];
const ORDINAL = ["first", "second", "third", "fourth", "fifth"];
const CARPALS = ["scaphoid", "lunate", "triquetral", "pisiform", "trapezium", "trapezoid", "capitate", "hamate"];

async function main() {
  await MeshoptSimplifier.ready;
  mkdirSync(OUT, { recursive: true });
  mkdirSync(join(SRC, "obj"), { recursive: true });
  const listPath = join(SRC, "download/isa_element_parts.txt");
  await download(`${BP3D}/isa_element_parts.txt`, listPath);
  const concepts = loadConcepts(listPath);
  console.log("Reading BodyParts3D archive index ...");
  const cache = new MeshCache(await readZipIndex(ZIP_URL), join(SRC, "obj"));
  const part = async (names) => merge(await Promise.all(names.flatMap(concepts.elements).map((fj) => cache.get(fj))));

  // --- landmarks for fitting BodyParts3D to the canonical face -----------
  const canon = await loadCanonical();
  const C = canon.positions;
  const sclera = {};
  for (const side of ["left", "right"]) sclera[side] = mean((await part([`${side} sclera`])).positions);
  const nasal = await part(["nasal bone"]);
  const nasion = nasal.positions.reduce((best, p) => (p[1] > best[1] ? p : best));
  const mandibleRaw = await part(["mandible"]);
  const menton = mandibleRaw.positions
    .filter((p) => Math.abs(p[0] - nasion[0]) < 1.0)
    .reduce((best, p) => (p[1] < best[1] ? p : best));
  // Canonical counterparts, with typical soft-tissue thickness removed (cm).
  const eyeCenter = (a, b) => add(lerp(C[a], C[b], 0.5), [0, 0, -1.0]);
  const target = {
    right: eyeCenter(33, 133), // subject's right eye
    left: eyeCenter(263, 362),
    nasion: add(C[168], [0, 0, -0.6]),
    menton: add(C[152], [0, 0.7, -0.9]),
  };
  const fit = similarity([sclera.right, sclera.left, nasion, menton], [target.right, target.left, target.nasion, target.menton]);
  const res = [sclera.right, sclera.left, nasion, menton].map((p, i) => norm(sub(fit.apply(p), Object.values(target)[i])));
  console.log(`Head fit: scale ${fit.scale.toFixed(3)}, residuals ${res.map((r) => r.toFixed(2)).join(", ")} cm`);
  const fitted = (mesh) => transform(mesh, fit.apply);

  // --- skull and jaw -----------------------------------------------------
  console.log("Building layers:");
  const teeth = concepts.elements("tooth");
  const upperTeeth = teeth.filter((fj) => concepts.specific(fj).includes("upper"));
  const lowerTeeth = teeth.filter((fj) => concepts.specific(fj).includes("lower"));
  const loadAll = async (ids) => merge(await Promise.all(ids.map((fj) => cache.get(fj))));
  const skullParts = [];
  for (const [name, names, budget, rule] of SKULL_PARTS) {
    const m = fitted(await part(names));
    skullParts.push({ name, mesh: finalize(m, budget), extras: rule ? { labels: [{ text: name, anchor: anchorBy(m, rule) }] } : {} });
  }
  // Extra label on the frontal bone: the orbit rim beside the subject's right eye.
  const orbit = add(fitted({ positions: [sclera.right], faces: [] }).positions[0], [-1.9, 0.2, 0.4]);
  skullParts[0].extras.labels.push({ text: "Orbit (eye socket)", anchor: orbit });
  const upper = fitted(await loadAll(upperTeeth));
  skullParts.push({ name: "Upper teeth", mesh: finalize(upper, 4000), extras: { labels: [{ text: "Teeth", anchor: anchorBy(upper, "front") }] } });
  await writeGlb("skull", skullParts);

  const mandible = fitted(mandibleRaw);
  const lower = fitted(await loadAll(lowerTeeth));
  // Jaw pivot: midpoint of the two condyles (top of the mandible on each side).
  const condyle = (sgn) => {
    const side = mandible.positions.filter((p) => sgn * p[0] > 2);
    const top = Math.max(...side.map((p) => p[1]));
    return mean(side.filter((p) => p[1] > top - 0.8));
  };
  const pivot = lerp(condyle(1), condyle(-1), 0.5);
  await writeGlb("jaw", [
    { name: "Mandible", mesh: finalize(mandible, 7000), extras: { labels: [{ text: "Mandible", anchor: anchorBy(mandible, "leftLow") }], pivot } },
    { name: "Lower teeth", mesh: finalize(lower, 4000), extras: { pivot } },
  ]);

  // --- eyes ---------------------------------------------------------------
  const eyes = [];
  for (const side of ["right", "left"]) {
    const m = fitted(await part([`${side} sclera`, `${side} cornea`, `${side} lens`]));
    eyes.push({ name: `Eyeball (${side})`, mesh: finalize(m, 2000), extras: side === "left" ? { labels: [{ text: "Eyeball", anchor: anchorBy(m, "front") }] } : {} });
  }
  await writeGlb("eyes", eyes);

  // --- brain (cortex gyri grouped into lobes) ------------------------------
  const brainElements = new Set([
    ...concepts.elements("segment of brain"),
    ...["cerebellum", "midbrain", "pons", "medulla oblongata"].flatMap(concepts.elements),
  ]);
  const lobeOf = (fj) => {
    const name = concepts.specific(fj);
    for (const [lobe, keys] of Object.entries(BRAIN_LOBES)) if (keys.some((k) => name.includes(k))) return lobe;
    throw new Error(`Brain element ${fj} ("${name}") has no lobe`);
  };
  const lobes = new Map();
  for (const fj of brainElements) {
    const lobe = lobeOf(fj);
    if (!lobes.has(lobe)) lobes.set(lobe, []);
    lobes.get(lobe).push(fj);
  }
  const brain = [];
  for (const [lobe, ids] of lobes) {
    const m = fitted(await loadAll(ids));
    const rule = BRAIN_ANCHOR[lobe];
    brain.push({ name: lobe, mesh: finalize(m, BRAIN_BUDGET[lobe]), extras: rule ? { labels: [{ text: lobe, anchor: anchorBy(m, rule) }] } : {} });
  }
  await writeGlb("brain", brain);

  // --- head outline: body skin cropped to head and upper neck --------------
  const skin = fitted(await part(["skin"]));
  const chinY = fitted({ positions: [menton], faces: [] }).positions[0][1];
  const keep = skin.faces.filter((f) => f.every((i) => skin.positions[i][1] > chinY - 0.8 && Math.abs(skin.positions[i][0]) < 9.5));
  await writeGlb("head", [{ name: "Head outline", mesh: finalize({ positions: skin.positions, faces: keep }, 16000), extras: {} }]);

  // --- hand bones -----------------------------------------------------------
  for (const side of ["left", "right"]) await writeGlb(`hand_${side}`, await buildHand(side, part));

  // --- facial muscles (generated) -------------------------------------------
  await writeGlb("muscles", buildMuscles(canon));

  writeFileSync(
    join(OUT, "CREDITS.txt"),
    "Skull, jaw, teeth, eyes, brain, head outline and hand bones: BodyParts3D, (c) The Database Center for Life Science,\n" +
      "licensed under CC Attribution-Share Alike 2.1 Japan (https://dbarchive.biosciencedbc.jp/en/bodyparts3d/).\n" +
      "Modified: selected parts, converted, fitted to the MediaPipe canonical face, simplified.\n\n" +
      "Facial muscles: generated from the MediaPipe canonical face model (Apache License 2.0).\n",
  );
  console.log(`Done. Files in ${OUT}`);
}

async function buildHand(side, part) {
  const bones = []; // {name, segment: [fromLandmark, toLandmark, fromLerp], mesh}
  const load = async (concept) => part([concept]);
  for (let f = 0; f < 5; f++) {
    const finger = FINGERS[f];
    const mcp = [2, 5, 9, 13, 17][f]; // landmark at the metacarpal head
    bones.push({ name: `${ORDINAL[f]} metacarpal`, from: f === 0 ? 1 : 0, to: mcp, fromLerp: f === 0 ? 0 : 0.25, mesh: await load(`${side} ${ORDINAL[f]} metacarpal bone`) });
    bones.push({ name: `proximal phalanx of ${finger}`, from: mcp, to: mcp + 1, mesh: await load(`proximal phalanx of ${side} ${finger}`) });
    if (f > 0) bones.push({ name: `middle phalanx of ${finger}`, from: mcp + 1, to: mcp + 2, mesh: await load(`middle phalanx of ${side} ${finger}`) });
    bones.push({ name: `distal phalanx of ${finger}`, from: f === 0 ? 3 : mcp + 2, to: f === 0 ? 4 : mcp + 3, mesh: await load(`distal phalanx of ${side} ${finger}`) });
  }
  const carpals = merge(await Promise.all(CARPALS.map((c) => load(`${side} ${c}`))));
  const carpalCenter = mean(carpals.positions);

  // Bone end points along each bone's principal axis; proximal = nearer the carpals.
  const ends = (mesh) => {
    const c = mean(mesh.positions), axis = principalAxis(mesh.positions);
    const t = mesh.positions.map((p) => dot(sub(p, c), axis));
    const lo = Math.min(...t), hi = Math.max(...t), band = 0.12 * (hi - lo);
    const a = mean(mesh.positions.filter((_, i) => t[i] < lo + band));
    const b = mean(mesh.positions.filter((_, i) => t[i] > hi - band));
    return norm(sub(a, carpalCenter)) < norm(sub(b, carpalCenter)) ? [a, b] : [b, a];
  };
  for (const b of bones) [b.prox, b.dist] = ends(b.mesh);
  const meta = (i) => bones.find((b) => b.name === `${ORDINAL[i]} metacarpal`);
  const radial = unit(sub(meta(1).dist, meta(4).dist)); // little-finger side -> index side

  const toLocal = (mesh, origin, yAxis) => {
    const y = unit(yAxis);
    const x = unit(sub(radial, scale(y, dot(radial, y))));
    const z = cross(x, y);
    return transform(mesh, (p) => {
      const d = sub(p, origin);
      return [dot(d, x), dot(d, y), dot(d, z)];
    });
  };
  const parts = bones.map((b) => ({
    name: b.name,
    mesh: finalize(toLocal(b.mesh, b.prox, sub(b.dist, b.prox)), 700),
    extras: { from: b.from, to: b.to, fromLerp: b.fromLerp || 0, restLength: norm(sub(b.dist, b.prox)) },
  }));
  // Carpals ride on the palm frame: origin at the middle metacarpal base, +Y toward its head.
  const m3 = meta(2);
  parts.push({
    name: "carpals",
    mesh: finalize(toLocal(carpals, m3.prox, sub(m3.dist, m3.prox)), 2000),
    extras: { from: 0, to: 9, fromLerp: 0.25, restLength: norm(sub(m3.dist, m3.prox)), palm: true },
  });
  return parts;
}

// Facial muscles generated on the canonical face surface (cm).
function buildMuscles(canon) {
  // Subdivide the face mesh twice (midpoint split) for smoother region borders.
  let P = canon.positions.map((p) => p.slice()), F = canon.faces;
  for (let pass = 0; pass < 2; pass++) {
    const mid = new Map(), next = [];
    const m = (a, b) => {
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      if (!mid.has(key)) mid.set(key, P.push(lerp(P[a], P[b], 0.5)) - 1);
      return mid.get(key);
    };
    for (const [a, b, c] of F) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      next.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    F = next;
  }
  // Vertex normals, oriented outward (the nose tip normal must point to +z).
  const N = P.map(() => [0, 0, 0]);
  for (const [a, b, c] of F) {
    const n = cross(sub(P[b], P[a]), sub(P[c], P[a]));
    for (const v of [a, b, c]) N[v] = add(N[v], n);
  }
  const flip = N[1][2] < 0 ? -1 : 1;
  const Nn = N.map((n) => scale(unit(n), flip));
  const C = canon.positions;

  const ellipseRing = (center, outer, inner) => (p) => {
    const dx = p[0] - center[0], dy = p[1] - center[1];
    return (dx / outer[0]) ** 2 + (dy / outer[1]) ** 2 < 1 && (dx / inner[0]) ** 2 + (dy / inner[1]) ** 2 > 1;
  };
  const band = (a, b, width) => (p) => {
    const ab = sub(b, a), t = Math.max(0, Math.min(1, dot(sub(p, a), ab) / dot(ab, ab)));
    return norm(sub(p, lerp(a, b, t))) < width;
  };
  const polygon = (ids) => (p) => {
    let inside = false;
    for (let i = 0, j = ids.length - 1; i < ids.length; j = i++) {
      const [xi, yi] = C[ids[i]], [xj, yj] = C[ids[j]];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const eye = (ids) => mean(ids.map((i) => C[i]));
  const regions = [
    ["Frontalis", polygon([21, 54, 103, 67, 109, 10, 338, 297, 332, 284, 251, 300, 293, 334, 296, 336, 9, 107, 66, 105, 63, 70]), "Frontalis"],
    ["Orbicularis oculi (right)", ellipseRing(eye([33, 133, 159, 145]), [2.5, 1.9], [1.45, 0.75]), "Orbicularis oculi"],
    ["Orbicularis oculi (left)", ellipseRing(eye([263, 362, 386, 374]), [2.5, 1.9], [1.45, 0.75]), null],
    ["Orbicularis oris", ellipseRing(eye([13, 14, 61, 291]), [3.1, 2.1], [1.9, 0.35]), "Orbicularis oris"],
    ["Zygomaticus major (right)", band(C[116], C[61], 0.6), null],
    ["Zygomaticus major (left)", band(C[345], C[291], 0.6), "Zygomaticus major"],
    ["Masseter (right)", band(C[227], C[172], 1.3), "Masseter"],
    ["Masseter (left)", band(C[447], C[397], 1.3), null],
    ["Temporalis (right)", band(C[54], C[127], 1.4), null],
    ["Temporalis (left)", band(C[284], C[356], 1.4), "Temporalis"],
  ];
  const depth = 0.35; // cm under the skin surface
  return regions.map(([name, inside, label]) => {
    const faces = F.filter((f) => inside(mean(f.map((i) => P[i]))));
    const positions = P.map((p, i) => add(p, scale(Nn[i], -depth)));
    const mesh = { positions, faces };
    const used = [...new Set(faces.flat())].map((i) => positions[i]);
    return { name, mesh: finalize(mesh, 4000), extras: label ? { labels: [{ text: label, anchor: mean(used) }] } : {} };
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
