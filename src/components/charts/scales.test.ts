import { describe, expect, it } from 'vitest'

import { bandScale, linearScale, niceMax, ticks } from './scales'

describe('linearScale', () => {
  it('maps domain endpoints + midpoint onto the range', () => {
    const s = linearScale([0, 10], [0, 100])
    expect(s(0)).toBe(0)
    expect(s(10)).toBe(100)
    expect(s(5)).toBe(50)
  })

  it('supports an inverted range (pixel y grows downward)', () => {
    const s = linearScale([0, 10], [100, 0])
    expect(s(0)).toBe(100)
    expect(s(10)).toBe(0)
  })

  it('maps a degenerate domain to the range start (no divide-by-zero)', () => {
    const s = linearScale([5, 5], [20, 80])
    expect(s(5)).toBe(20)
    expect(s(999)).toBe(20)
  })
})

describe('bandScale', () => {
  it('positions evenly spaced bands with inner padding', () => {
    const b = bandScale(4, [0, 400], 0.2)
    expect(b.step).toBe(100)
    expect(b.bandwidth).toBe(80)
    expect(b(0)).toBe(10)
    expect(b(1)).toBe(110)
    expect(b(3)).toBe(310)
  })

  it('degrades to zero width for zero count', () => {
    const b = bandScale(0, [0, 100])
    expect(b.bandwidth).toBe(0)
    expect(b(0)).toBe(0)
  })
})

describe('niceMax', () => {
  it.each([
    [274, 300],
    [116, 150],
    [35, 35],
    [10, 10],
    [5, 5],
    [0, 1],
    [-4, 1],
  ])('rounds %i up to a clean axis max %i', (input, expected) => {
    expect(niceMax(input)).toBe(expected)
  })
})

describe('ticks', () => {
  it('returns count+1 evenly spaced rounded ticks', () => {
    expect(ticks(300, 4)).toEqual([0, 75, 150, 225, 300])
  })

  it('degrades to [0] for a non-positive max', () => {
    expect(ticks(0)).toEqual([0])
  })
})
