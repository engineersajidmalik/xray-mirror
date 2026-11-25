// One-Euro filter (Casiez et al. 2012): heavy smoothing when still (no jitter),
// light smoothing when moving fast (low latency). Works on fixed-size vectors.

const alpha = (cutoff: number, dt: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  private x: number[] | null = null;
  private dx: number[] = [];
  private t = 0;

  constructor(
    private minCutoff: number,
    private beta: number,
    private dCutoff = 1,
  ) {}

  reset(): void {
    this.x = null;
  }

  filter(value: number[], tSeconds: number): number[] {
    if (!this.x) {
      this.x = value.slice();
      this.dx = value.map(() => 0);
      this.t = tSeconds;
      return this.x.slice();
    }
    const dt = Math.max(tSeconds - this.t, 1e-3);
    this.t = tSeconds;
    const aD = alpha(this.dCutoff, dt);
    let speed = 0;
    for (let i = 0; i < value.length; i++) {
      this.dx[i] = aD * ((value[i] - this.x[i]) / dt) + (1 - aD) * this.dx[i];
      speed += this.dx[i] * this.dx[i];
    }
    const a = alpha(this.minCutoff + this.beta * Math.sqrt(speed), dt);
    for (let i = 0; i < value.length; i++) this.x[i] = a * value[i] + (1 - a) * this.x[i];
    return this.x.slice();
  }
}
