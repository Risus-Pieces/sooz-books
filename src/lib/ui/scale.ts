/**
 * Axis arithmetic for the charts. Everything is in integer cents; a step is always a "nice" number
 * (1, 2, 2.5 or 5 × a power of ten), the ticks always include zero, and the domain is never taller
 * than the data needs plus one step.
 */

const NICE = [1, 2, 2.5, 5, 10] as const;

/** The smallest nice step at least `raw` (cents, positive). */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  for (const m of NICE) {
    const step = m * magnitude;
    if (step >= raw) return Math.round(step);
  }
  return Math.round(10 * magnitude);
}

export interface Ticks {
  /** Tick values in cents, ascending, always containing 0. */
  values: number[];
  step: number;
  min: number;
  max: number;
}

/**
 * Even ticks covering [min, max] with about `count` intervals. The data's own minimum and maximum
 * are widened to include zero, then rounded out to whole steps.
 */
export function evenTicks(dataMin: number, dataMax: number, count = 4): Ticks {
  const lo = Math.min(0, dataMin);
  const hi = Math.max(0, dataMax);
  const span = hi - lo;
  if (span === 0) return { values: [0, 100], step: 100, min: 0, max: 100 };
  const step = niceStep(span / Math.max(1, count));
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const values: number[] = [];
  for (let v = min; v <= max; v += step) values.push(v === 0 ? 0 : v);
  return { values, step, min, max };
}

/**
 * Ticks for a chart that diverges from zero: the same step above and below, so "$1K" up and
 * "−$1K" down sit the same distance from the zero line.
 */
export function divergingTicks(maxUp: number, maxDown: number, count = 6): Ticks {
  const up = Math.max(0, maxUp);
  const down = Math.max(0, maxDown);
  const span = up + down;
  if (span === 0) return { values: [0], step: 100, min: 0, max: 0 };
  const step = niceStep(span / Math.max(2, count));
  const max = Math.ceil(up / step) * step;
  const min = -Math.ceil(down / step) * step;
  const values: number[] = [];
  for (let v = min; v <= max; v += step) values.push(v === 0 ? 0 : v);
  return { values, step, min, max };
}

/** A linear map from [d0, d1] onto [r0, r1]. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** One decimal, for SVG coordinates: short markup, no visible loss. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
