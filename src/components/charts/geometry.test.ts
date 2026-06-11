import { describe, expect, it } from 'vitest'

import { areaPath, linePath, type PixelPoint } from './geometry'

const POINTS: PixelPoint[] = [
  { x: 0, y: 100 },
  { x: 50, y: 60 },
  { x: 100, y: 20 },
]

describe('linePath', () => {
  it('returns an SVG path starting with a move command', () => {
    const d = linePath(POINTS)
    expect(d.startsWith('M')).toBe(true)
    expect(d.length).toBeGreaterThan(0)
  })

  it('returns empty string for no points', () => {
    expect(linePath([])).toBe('')
  })
})

describe('areaPath', () => {
  it('returns a closed SVG area path that reaches the baseline', () => {
    const d = areaPath(POINTS, 120)
    expect(d.startsWith('M')).toBe(true)
    // An area is closed back to its baseline.
    expect(d.includes('Z')).toBe(true)
  })

  it('returns empty string for no points', () => {
    expect(areaPath([], 100)).toBe('')
  })
})
