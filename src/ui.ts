// Control panel. Every change updates the settings object, saves it and calls onChange.
import { DEFAULT_FIT, type LayerId, type Reveal, type Settings, saveSettings } from "./settings";

const LAYER_ROWS: [LayerId, string, string][] = [
  ["skull", "Skull", "#e8f4ff"],
  ["brain", "Brain", "#ff8fc0"],
  ["muscles", "Muscles", "#ff7a66"],
  ["eyes", "Eyes", "#fff2b0"],
  ["head", "Head outline", "#4aa8ff"],
  ["hands", "Hand bones", "#f2f8ff"],
];

const PRESETS: [string, Partial<Record<LayerId, boolean>>][] = [
  ["Skull", { skull: true, brain: false, muscles: false, eyes: true, head: true }],
  ["Brain", { skull: false, brain: true, muscles: false, eyes: true, head: true }],
  ["Muscles", { skull: true, brain: false, muscles: true, eyes: true, head: false }],
  ["Everything", { skull: true, brain: true, muscles: true, eyes: true, head: true, hands: true }],
];

const REVEALS: [Reveal, string][] = [
  ["whole", "Whole head"],
  ["left", "Left half only"],
  ["right", "Right half only"],
  ["top", "Top of the head only"],
  ["lower", "Lower face only"],
  ["lens", "X-ray lens (follows your fingertip)"],
];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const cm = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} cm`;

export function buildPanel(panel: HTMLElement, s: Settings, onChange: () => void): void {
  const refreshers: (() => void)[] = [];
  const changed = () => {
    saveSettings(s);
    refreshers.forEach((r) => r());
    onChange();
  };
  const el = <T extends HTMLElement = HTMLElement>(tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string)[]): T => {
    const e = Object.assign(document.createElement(tag), props) as T;
    e.append(...kids);
    return e;
  };
  const section = (title: string) => panel.appendChild(el("h2", { textContent: title }));
  const checkbox = (label: string, get: () => boolean, set: (v: boolean) => void, dot?: string) => {
    const box = el<HTMLInputElement>("input", { type: "checkbox" });
    box.addEventListener("change", () => (set(box.checked), changed()));
    refreshers.push(() => (box.checked = get()));
    const row = el("label", {}, box);
    if (dot) row.append(el("span", { className: "dot", style: `background:${dot}` }));
    row.append(label);
    return panel.appendChild(row);
  };
  const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
    const input = el<HTMLInputElement>("input", { type: "range", min: String(min), max: String(max), step: String(step) });
    const out = el("output");
    input.addEventListener("input", () => (set(Number(input.value)), changed()));
    refreshers.push(() => {
      input.value = String(get());
      out.textContent = fmt(get());
    });
    return panel.appendChild(el("div", { className: "row" }, el("span", { textContent: label }), input, out));
  };
  const buttons = (items: [string, () => void, (() => boolean)?][]) => {
    const wrap = el("div", { className: "buttons" });
    for (const [label, act, isOn] of items) {
      const b = el<HTMLButtonElement>("button", { textContent: label, type: "button" });
      b.addEventListener("click", () => (act(), changed()));
      if (isOn) refreshers.push(() => b.classList.toggle("on", isOn()));
      wrap.append(b);
    }
    return panel.appendChild(wrap);
  };
  const shownWhen = (node: HTMLElement, cond: () => boolean) => refreshers.push(() => (node.hidden = !cond()));

  section("Layers");
  buttons(PRESETS.map(([name, layers]) => [name, () => Object.assign(s.layers, layers)]));
  for (const [id, label, color] of LAYER_ROWS) checkbox(label, () => s.layers[id], (v) => (s.layers[id] = v), color);
  checkbox("Show labels", () => s.labels, (v) => (s.labels = v));

  section("Look");
  buttons([
    ["X-ray", () => (s.look = "xray"), () => s.look === "xray"],
    ["Solid", () => (s.look = "solid"), () => s.look === "solid"],
  ]);
  slider("Brightness", 0.3, 2, 0.05, () => s.brightness, (v) => (s.brightness = v), pct);

  section("Mixed reality");
  slider("Real me showing through", 0, 1, 0.01, () => s.realMe, (v) => (s.realMe = v), pct);
  slider("Edge feather", 0, 0.5, 0.01, () => s.feather, (v) => (s.feather = v), pct);
  const select = el<HTMLSelectElement>("select");
  for (const [value, label] of REVEALS) select.append(el("option", { value, textContent: label }));
  select.addEventListener("change", () => ((s.reveal = select.value as Reveal), changed()));
  refreshers.push(() => (select.value = s.reveal));
  panel.appendChild(el("label", {}, "Reveal", select));
  shownWhen(slider("Lens size", 0.05, 0.5, 0.01, () => s.lensSize, (v) => (s.lensSize = v), pct), () => s.reveal === "lens");
  shownWhen(slider("Cut position", -6, 6, 0.1, () => s.cut, (v) => (s.cut = v), cm), () => s.reveal !== "whole" && s.reveal !== "lens");

  section("Fit to my head");
  slider("Overall size", 0.7, 1.5, 0.01, () => s.fit.size, (v) => (s.fit.size = v), pct);
  slider("Width", 0.7, 1.3, 0.01, () => s.fit.width, (v) => (s.fit.width = v), pct);
  slider("Height", 0.7, 1.3, 0.01, () => s.fit.height, (v) => (s.fit.height = v), pct);
  slider("Depth", 0.7, 1.3, 0.01, () => s.fit.depth, (v) => (s.fit.depth = v), pct);
  slider("Left / right", -5, 5, 0.1, () => s.fit.x, (v) => (s.fit.x = v), cm);
  slider("Up / down", -5, 5, 0.1, () => s.fit.y, (v) => (s.fit.y = v), cm);
  slider("Forward / back", -5, 5, 0.1, () => s.fit.z, (v) => (s.fit.z = v), cm);
  buttons([["Reset fit", () => (s.fit = { ...DEFAULT_FIT })]]);
  panel.appendChild(
    el("p", { className: "tip", textContent: "Tip: pick the Solid look and set “Real me showing through” to about half, then line the skull up with your face." }),
  );

  section("Tracking");
  checkbox("Show tracking data", () => s.debug, (v) => (s.debug = v));

  refreshers.forEach((r) => r());
}
