/**
 * SVG path geometry for the chart primitives — U9 (single-renderer, KTD4).
 *
 * Thin pure wrappers over `d3-shape` line/area generators. Components map data to
 * pixel points (via scales.ts) then call these for the `d` strings. Kept separate
 * + pure so the path output is unit-testable without a DOM.
 */

import { area as d3area, curveMonotoneX, line as d3line } from 'd3-shape'
import type { CurveFactory } from 'd3-shape'

/** A point already mapped to pixel space. */
export interface PixelPoint {
  x: number
  y: number
}

/**
 * SVG `d` for a line through pixel points, monotone-smoothed by default
 * (no overshoot — honest for a cumulative curve). Empty input → ''.
 */
export function linePath(
  points: readonly PixelPoint[],
  curve: CurveFactory = curveMonotoneX
): string {
  if (points.length === 0) return ''
  return (
    d3line<PixelPoint>()
      .x((p) => p.x)
      .y((p) => p.y)
      .curve(curve)([...points]) ?? ''
  )
}

/**
 * SVG `d` for a filled area from `baselineY` up to the pixel points (same curve
 * as the line so the fill hugs it). Empty input → ''.
 */
export function areaPath(
  points: readonly PixelPoint[],
  baselineY: number,
  curve: CurveFactory = curveMonotoneX
): string {
  if (points.length === 0) return ''
  return (
    d3area<PixelPoint>()
      .x((p) => p.x)
      .y0(baselineY)
      .y1((p) => p.y)
      .curve(curve)([...points]) ?? ''
  )
}
