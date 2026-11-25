// Head anatomy: lazily loaded GLB layers pinned to the tracked head.
import { Group, type Material, type Mesh, type Object3D, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { backdropMaterial, solidMaterial, type XrayStyle, xrayMaterial } from "./materials";
import type { Fit, LayerId, Look } from "./settings";

const BASE = import.meta.env.BASE_URL;
/** Render layer for see-through shells (outline, backdrop): excluded from the solid look's depth pre-pass. */
export const SHELL_LAYER = 1;

/** Per-layer look. Head-layer files are in canonical face space (cm). */
const LAYERS: Record<Exclude<LayerId, "hands">, { files: string[]; color: string; solid: string; xray: number; style: XrayStyle; body?: number }> = {
  skull: { files: ["skull", "jaw"], color: "#e8f4ff", solid: "#e9e2cf", xray: 0.75, style: "bone" },
  brain: { files: ["brain"], color: "#ff5fb4", solid: "#e8a0b4", xray: 0.5, style: "soft", body: 0.12 },
  muscles: { files: ["muscles"], color: "#ff6a55", solid: "#c4523f", xray: 0.8, style: "soft", body: 0.45 },
  eyes: { files: ["eyes"], color: "#fff2b0", solid: "#f4f0e0", xray: 0.6, style: "soft" },
  head: { files: ["head"], color: "#4aa8ff", solid: "#d9b9a0", xray: 0.7, style: "rim" },
};
/** Extra X-ray strength for parts that must stay readable through everything else. */
const BOOST: Record<string, number> = { "Upper teeth": 1.7, "Lower teeth": 1.7, Mandible: 1.25 };
type HeadLayer = keyof typeof LAYERS;

export interface LabelAnchor {
  text: string;
  object: Object3D; // anchor is in this object's local space
  local: Vector3;
  layer: HeadLayer;
}

interface Layer {
  group: Group;
  meshes: { mesh: Mesh; xray: Material; solid: Material }[];
  loading: Promise<void> | null;
}

export class Anatomy {
  /** Receives the tracked head matrix (canonical face space -> camera space). */
  readonly head = new Group();
  /** Fit-to-my-head transform, applied inside the head. */
  readonly fit = new Group();
  /** Rotates with jawOpen; positioned at the jaw joints. */
  private jaw = new Group();
  private jawMax = (28 * Math.PI) / 180;
  private layers = new Map<HeadLayer, Layer>();
  private loader = new GLTFLoader();
  private look: Look = "xray";
  readonly labels: LabelAnchor[] = [];
  /** Invisible-by-default backdrop shell for the mixed-reality "film". */
  private backdrop: Mesh | null = null;

  constructor() {
    this.head.matrixAutoUpdate = false;
    this.head.add(this.fit);
    this.fit.add(this.jaw);
  }

  /** Shows/hides a layer, loading its files on first use. */
  setVisible(id: HeadLayer, on: boolean): Promise<void> {
    let layer = this.layers.get(id);
    if (!layer) {
      if (!on) return Promise.resolve();
      layer = { group: new Group(), meshes: [], loading: null };
      this.layers.set(id, layer);
      this.fit.add(layer.group);
      layer.loading = this.load(id, layer);
    }
    layer.group.visible = on;
    if (id === "skull") this.jaw.visible = on;
    return layer.loading ?? Promise.resolve();
  }

  visibleLayers(): HeadLayer[] {
    return [...this.layers].filter(([, l]) => l.group.visible && l.meshes.length).map(([id]) => id);
  }

  private async load(id: HeadLayer, layer: Layer): Promise<void> {
    const spec = LAYERS[id];
    for (const file of spec.files) {
      const gltf = await this.loader.loadAsync(`${BASE}anatomy/${file}.glb`);
      for (const node of [...gltf.scene.children]) {
        const mesh = node as Mesh;
        const extras = mesh.userData as { labels?: { text: string; anchor: number[] }[]; pivot?: number[] };
        const parent = extras.pivot ? this.jaw : layer.group;
        if (extras.pivot) {
          this.jaw.position.fromArray(extras.pivot);
          mesh.position.set(-extras.pivot[0], -extras.pivot[1], -extras.pivot[2]);
        }
        const xray = xrayMaterial(spec.color, spec.xray * (BOOST[mesh.name] ?? 1), spec.style, spec.body);
        // The head outline stays a glowing rim in both looks (an opaque skin would hide everything).
        const solid = id === "head" ? xray : solidMaterial(spec.solid);
        if (id === "head") mesh.layers.set(SHELL_LAYER);
        mesh.material = this.look === "xray" ? xray : solid;
        mesh.renderOrder = id === "head" ? 1 : 2;
        parent.add(mesh);
        layer.meshes.push({ mesh, xray, solid });
        for (const l of extras.labels ?? []) {
          this.labels.push({ text: l.text, object: mesh, local: new Vector3().fromArray(l.anchor), layer: id });
        }
        if (id === "head" && !this.backdrop) {
          this.backdrop = (mesh as Mesh).clone();
          this.backdrop.material = backdropMaterial();
          this.backdrop.renderOrder = 0;
          this.backdrop.layers.set(SHELL_LAYER);
          this.backdrop.visible = this.look === "xray";
          this.fit.add(this.backdrop);
        }
      }
    }
  }

  /** Loads the head shell used by the backdrop even if the outline layer is hidden. */
  async ensureBackdrop(): Promise<void> {
    if (this.backdrop) return;
    const gltf = await this.loader.loadAsync(`${BASE}anatomy/head.glb`);
    if (this.backdrop) return; // the outline layer may have created it meanwhile
    const mesh = gltf.scene.children[0] as Mesh;
    mesh.material = backdropMaterial();
    mesh.renderOrder = 0;
    mesh.layers.set(SHELL_LAYER);
    mesh.visible = this.look === "xray";
    this.backdrop = mesh;
    this.fit.add(mesh);
  }

  setLook(look: Look): void {
    this.look = look;
    // In the solid look the see-through bones themselves are the "film"; the dark backdrop would double it.
    if (this.backdrop) this.backdrop.visible = look === "xray";
    for (const layer of this.layers.values()) {
      for (const m of layer.meshes) m.mesh.material = look === "xray" ? m.xray : m.solid;
    }
  }

  setFit(f: Fit): void {
    this.fit.position.set(-f.x, f.y, f.z); // +x is the subject's left = screen left in the mirror
    this.fit.scale.set(f.size * f.width, f.size * f.height, f.size * f.depth);
  }

  setJawOpen(v: number): void {
    this.jaw.rotation.x = v * this.jawMax;
  }
}
