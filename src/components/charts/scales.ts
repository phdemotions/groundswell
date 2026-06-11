/**
 * Pure scales for the chart primitives — U9 (single-renderer, KTD4).
 *
 * Hand-rolled linear + band scales so the charts need only `d3-shape` (path
 * geometry) and not `d3-scale`/`d3-array`. Pure + unit-tested; the components
 * import these to map data → pixel space.
 */

/** A linear domain → range map. Callable; carries its domain/range for reuse. */
export interface LinearScale {
  (value: number): number
  readonly domain: readonly [number, number]
  readonly range: readonly [number, number]
}

/**
 * Map a numeric `domain` onto a pixel `range` linearly. A degenerate (zero-width)
 * domain maps everything to the range start (no divide-by-zero). Values outside
 * the domain extrapolate (callers clamp inputs where needed).
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number]
): LinearScale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const span = d1 - d0
  const fn = ((value: number): number =>
    span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0)) as {
    (value: number): number
    domain: readonly [number, number]
    range: readonly [number, number]
  }
  fn.domain = domain
  fn.range = range
  return fn as LinearScale
}

/** A band scale: evenly spaced slots with inner padding (for bar charts). */
export interface BandScale {
  /** Left edge x of band `index`. */
  (index: number): number
  readonly bandwidth: number
  readonly count: number
  readonly step: number
}

/**
 * `count` evenly spaced bands across `range`, each inset by `padding` (0..1) of
 * the step for the gap between bars. `bandwidth` is the drawn bar width.
 */
export function bandScale(
  count: number,
  range: readonly [number, number],
  padding = 0.2
): BandScale {
  const [r0, r1] = range
  const step = count > 0 ? (r1 - r0) / count : 0
  const bandwidth = Math.max(0, step * (1 - padding))
  const offset = (step - bandwidth) / 2
  const fn = ((index: number): number => r0 + index * step + offset) as {
    (index: number): number
    bandwidth: number
    count: number
    step: number
  }
  fn.bandwidth = bandwidth
  fn.count = count
  fn.step = step
  return fn as BandScale
}

/**
 * Round a value UP to a clean axis maximum for gridlines. Uses a half-magnitude
 * unit so the ceiling hugs the data: 274 → 300, 116 → 150, 10 → 10, 5 → 5.
 */
export function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const unit = magnitude / 2
  return Math.ceil(value / unit) * unit
}

/** `count`+1 evenly spaced, rounded tick values across `[0, max]` for gridlines. */
export function ticks(max: number, count = 4): number[] {
  if (count <= 0 || max <= 0) return [0]
  const step = max / count
  return Array.from({ length: count + 1 }, (_, i) => Math.round(step * i))
}
