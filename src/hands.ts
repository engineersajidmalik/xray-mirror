// Hand bones rigged to MediaPipe's 21 hand landmarks.
//
// Each bone mesh is stored in a local frame (origin at its proximal joint, +Y
// toward the distal joint, +X toward the thumb side). Every frame it is
// placed on its landmark segment (wrist->MCP, MCP->PIP->DIP->TIP):
//  - origin at the segment start, +Y along the segment;
//  - length scaled to the segment, thickness scaled by the whole hand's size
//    (wrist -> middle-finger knuckle), so bones stay slim and joints never inflate;
//  - +X from the palm plane (little-finger knuckle -> index knuckle).
import type { HandLandmarkerResult, NormalizedLandmark } from "@mediapipe/tasks-vision";
import { Group, type Material, Matrix4, type Mesh, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OneEuro } from "./filters";
import { solidMaterial, xrayMaterial } from "./materials";
import type { Look } from "./settings";

const BASE = import.meta.env.BASE_URL;
type Side = "left" | "right";

interface Bone {
  mesh: Mesh;
  from: number;
  to: number;
  fromLerp: number;
  restLength: number;
  xray: Material;
  solid: Material;
}

export interface HandsInfo {
  sides: Side[];
  indexTip: NormalizedLandmark | null; // first hand's index fingertip (video coords)
}

const PALM_EDGES: [number, number][] = [[0, 5], [0, 9], [0, 17], [5, 17]];
const TIPS = new Set([4, 8, 12, 16, 20]);
/** The tip landmark sits at the finger pad, beyond the end of the bone. */
const TIP_BONE_FRACTION = 0.78;
/** Bone thickness relative to the hand's overall scale (slimmer than the raw dataset). */
const THICKNESS = 0.85;

export class HandBones {
  readonly root = new Group();
  private rigs = new Map<Side, { group: Group; bones: Bone[]; palmRest: number }>();
  private filters = new Map<Side, OneEuro>();
  private loading: Promise<void> | null = null;
  private loader = new GLTFLoader();

  load(): Promise<void> {
    this.loading ??= Promise.all(
      (["left", "right"] as Side[]).map(async (side) => {
        const gltf = await this.loader.loadAsync(`${BASE}anatomy/hand_${side}.glb`);
        const group = new Group();
        const bones: Bone[] = [];
        let palmRest = 1;
        for (const node of [...gltf.scene.children]) {
          const mesh = node as Mesh;
          const e = mesh.userData as { from: number; to: number; fromLerp: number; restLength: number; palm?: boolean };
          mesh.matrixAutoUpdate = false;
          const xray = xrayMaterial("#f2f8ff", 0.9, "hand");
          const solid = solidMaterial("#ece4d2", true);
          mesh.material = xray;
          group.add(mesh);
          bones.push({ mesh, ...e, xray, solid });
          // The carpal block spans the middle metacarpal's base -> head: the hand's reference size.
          if (e.palm) palmRest = e.restLength;
        }
        group.visible = false;
        this.root.add(group);
        this.rigs.set(side, { group, bones, palmRest });
      }),
    ).then(() => undefined);
    return this.loading;
  }

  setLook(look: Look): void {
    for (const rig of this.rigs.values()) for (const b of rig.bones) b.mesh.material = look === "xray" ? b.xray : b.solid;
  }

  /**
   * Updates the rig. `tanY` = tan(vertical fov / 2) and `aspect` describe the
   * render camera, so landmarks land on the same screen points as in the video.
   */
  update(result: HandLandmarkerResult | null, tanY: number, aspect: number, show: boolean, tSeconds: number): HandsInfo {
    const info: HandsInfo = { sides: [], indexTip: null };
    for (const rig of this.rigs.values()) rig.group.visible = false;
    if (!result) return info;
    const seen = new Set<Side>();
    result.landmarks.forEach((lms, h) => {
      const world = result.worldLandmarks[h];
      // MediaPipe labels handedness as if the image were mirrored; our input is not.
      const side: Side = result.handedness[h]?.[0]?.categoryName === "Left" ? "right" : "left";
      if (seen.has(side) || !world) return; // two hands labelled the same side: keep the first
      seen.add(side);
      info.sides.push(side);
      if (h === 0) info.indexTip = lms[8];
      const rig = this.rigs.get(side);
      if (!show || !rig) return;

      // Smooth all 21 camera-space points together (One-Euro, in cm).
      const raw = cameraSpacePoints(lms, world, tanY, aspect);
      let filter = this.filters.get(side);
      if (!filter) this.filters.set(side, (filter = new OneEuro(1.5, 0.03)));
      const flat = filter.filter(raw.flatMap((p) => [p.x, p.y, p.z]), tSeconds);
      const P = raw.map((_, i) => new Vector3(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]));

      rig.group.visible = true;
      // Hand scale from wrist -> middle-finger knuckle (the carpal block uses the same 0.25 start).
      const handScale = (P[9].distanceTo(P[0]) * 0.75) / rig.palmRest;
      const radial = new Vector3().subVectors(P[5], P[17]); // palm plane: little -> index knuckle
      for (const b of rig.bones) {
        const start = P[b.from].clone().lerp(P[b.to], b.fromLerp);
        const y = new Vector3().subVectors(P[b.to], start);
        let len = y.length() * (TIPS.has(b.to) ? TIP_BONE_FRACTION : 1);
        len = Math.min(Math.max(len, b.restLength * handScale * 0.6), b.restLength * handScale * 1.5);
        y.normalize();
        const x = radial.clone().addScaledVector(y, -radial.dot(y)).normalize();
        const z = new Vector3().crossVectors(x, y);
        const thick = handScale * THICKNESS;
        b.mesh.matrix.copy(
          new Matrix4().makeBasis(x.multiplyScalar(thick), y.multiplyScalar(len / b.restLength), z.multiplyScalar(thick)).setPosition(start),
        );
        b.mesh.matrixWorldNeedsUpdate = true;
      }
    });
    for (const side of this.filters.keys()) if (!seen.has(side)) this.filters.delete(side); // restart smoothing when a hand reappears
    return info;
  }
}

/**
 * Camera-space positions (cm) of the 21 landmarks: each point lies on its
 * pixel's viewing ray; depth comes from comparing the palm's metric size
 * (world landmarks) with its size in the image, plus the world-landmark
 * relative depths.
 */
function cameraSpacePoints(lms: NormalizedLandmark[], world: { x: number; y: number; z: number }[], tanY: number, aspect: number): Vector3[] {
  const rays = lms.map((l) => new Vector3((l.x * 2 - 1) * tanY * aspect, (1 - l.y * 2) * tanY, -1));
  const w = world.map((p) => new Vector3(p.x * 100, -p.y * 100, -p.z * 100)); // m -> cm, y up, z toward camera
  let metric = 0, image = 0;
  for (const [a, b] of PALM_EDGES) {
    metric += Math.hypot(w[a].x - w[b].x, w[a].y - w[b].y);
    image += Math.hypot(rays[a].x - rays[b].x, rays[a].y - rays[b].y);
  }
  const wristDepth = metric / Math.max(image, 1e-6);
  return rays.map((r, i) => r.multiplyScalar(Math.max(5, wristDepth - (w[i].z - w[0].z))));
}
