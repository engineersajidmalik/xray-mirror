// Anatomical labels: hairline leader lines from structures to small
// semi-transparent tags in two columns beside the head, pushed apart so they
// never overlap.

export interface ScreenLabel {
  text: string;
  x: number; // anchor, CSS pixels on the (mirrored) display
  y: number;
}

const FONT = "500 11px 'Segoe UI', system-ui, sans-serif";
const BOX_H = 16;
const GAP = 3;
const MARGIN = 12;

/** Draws the labels; `opacity` fades them all (used when the head turns far to the side). */
export function drawLabels(
  ctx: CanvasRenderingContext2D,
  labels: ScreenLabel[],
  head: { left: number; right: number; centerX: number },
  width: number,
  height: number,
  opacity: number,
): number {
  if (opacity <= 0.01) return 0;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = FONT;
  ctx.textBaseline = "middle";
  const capacity = Math.max(1, Math.floor((height - 8) / (BOX_H + GAP)));
  let drawn = 0;
  for (const side of [-1, 1]) {
    // Labels keep the side their anchor is on; labels beyond what fits are dropped.
    const items = labels
      .filter((l) => (l.x < head.centerX ? -1 : 1) === side)
      .slice(0, capacity)
      .sort((a, b) => a.y - b.y);
    if (!items.length) continue;
    // Collision pass: start at the anchor heights, push down, then back up from the bottom edge.
    const ys = items.map((l) => l.y - BOX_H / 2);
    for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + BOX_H + GAP);
    const overflow = ys[ys.length - 1] + BOX_H - (height - 4);
    if (overflow > 0) for (let i = 0; i < ys.length; i++) ys[i] -= overflow;
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - BOX_H - GAP);
    if (ys[0] < 4) ys.forEach((_, i) => (ys[i] = 4 + i * (BOX_H + GAP)));

    items.forEach((label, i) => {
      const w = ctx.measureText(label.text).width + 10;
      const x = side < 0
        ? Math.max(4, Math.min(head.left - MARGIN - w, width - w - 4))
        : Math.min(width - w - 4, Math.max(head.right + MARGIN, 4));
      const y = ys[i];
      // Hairline leader line and a small dot on the anatomical point.
      ctx.strokeStyle = "rgba(170, 225, 255, 0.75)";
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(label.x, label.y);
      ctx.lineTo(side < 0 ? x + w : x, y + BOX_H / 2);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(label.x, label.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
      // Small semi-transparent tag.
      ctx.fillStyle = "rgba(6, 14, 28, 0.55)";
      ctx.beginPath();
      ctx.roundRect(x, y, w, BOX_H, 4);
      ctx.fill();
      ctx.fillStyle = "rgba(230, 243, 255, 0.95)";
      ctx.fillText(label.text, x + 5, y + BOX_H / 2 + 0.5);
      drawn++;
    });
  }
  ctx.restore();
  return drawn;
}
