// All user settings, persisted in localStorage.

export type LayerId = "skull" | "brain" | "muscles" | "eyes" | "head" | "hands";
export type Look = "xray" | "solid";
export type Reveal = "whole" | "left" | "right" | "top" | "lower" | "lens";

export interface Fit {
  size: number; // overall scale, 1 = 100 %
  width: number;
  height: number;
  depth: number;
  x: number; // offsets in cm (head space)
  y: number;
  z: number;
}

export interface Settings {
  layers: Record<LayerId, boolean>;
  labels: boolean;
  look: Look;
  brightness: number;
  realMe: number; // 0..1: how much of the camera shows through under the overlay
  feather: number; // 0..0.5 soft edge of the overlay mask
  reveal: Reveal;
  lensSize: number; // lens radius as a fraction of the view height
  cut: number; // cut position in cm for half / top / lower reveals
  fit: Fit;
  debug: boolean;
}

export const DEFAULT_FIT: Fit = { size: 1.17, width: 1, height: 1, depth: 1, x: 0, y: 0, z: 0 };

export const DEFAULTS: Settings = {
  layers: { skull: true, brain: true, muscles: true, eyes: true, head: true, hands: true }, // the "Everything" preset
  labels: true,
  look: "xray",
  brightness: 1,
  realMe: 0.35,
  feather: 0.17,
  reveal: "whole",
  lensSize: 0.22,
  cut: 0,
  fit: { ...DEFAULT_FIT },
  debug: false,
};

// v2: new defaults (Everything on); older saved settings are not carried over.
const SETTINGS_KEY = "xray-mirror-settings-v2";

export function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
    return {
      ...DEFAULTS,
      ...saved,
      layers: { ...DEFAULTS.layers, ...saved.layers },
      fit: { ...DEFAULT_FIT, ...saved.fit },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
