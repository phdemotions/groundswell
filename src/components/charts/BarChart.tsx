'use client'

/**
 * BarChart — U9. Vertical bars (the per-release download bars). `motion` grows
 * each bar from the baseline (scaleY, transform-origin bottom), staggered, on
 * whileInView (below the fold — animate when scrolled into view, once).
 *
 * Token-agnostic: colors arrive as props. Bar labels are SVG <text> (axis ticks),
 * but the headline stat numbers live in HTML on the page (a11y). The chart carries
 * an aria-label summarizing the series.
 */

import { motion } from 'motion/react'
import { useState } from 'react'

import { ChartTooltip } from './ChartTooltip'
import { bandScale, linearScale, niceMax } from './scales'

export interface BarDatum {
  label: string
  value: number
}

export interface BarChartProps {
  bars: BarDatum[]
  ariaLabel: string
  width?: number
  height?: number
  color?: string
  gridColor?: string
  axisColor?: string
  formatValue?: (v: number) => string
  /** Serializable suffix appended in the tooltip — Server-Component-safe. */
  valueSuffix?: string
  className?: string
}

interface HoverState {
  i: number
  x: number
  y: number
}

export function BarChart({
  bars,
  ariaLabel,
  width = 720,
  height = 300,
  color = 'currentColor',
  gridColor = 'rgba(0, 0, 0, 0.08)',
  axisColor = 'rgba(0, 0, 0, 0.45)',
  formatValue = (v) => v.toLocaleString('en-US'),
  valueSuffix = '',
  className,
}: BarChartProps) {
  const [hover, setHover] = useState<HoverState | null>(null)

  const pad = { t: 16, r: 8, b: 30, l: 8 }
  const innerH = height - pad.t - pad.b
  const baseline = pad.t + innerH
  const yMax = niceMax(Math.max(1, ...bars.map((b) => b.value)))
  const x = bandScale(bars.length, [pad.l, width - pad.r], 0.34)
  const yScale = linearScale([0, yMax], [baseline, pad.t])

  return (
    <div className={className} style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        width="100%"
        style={{ display: 'block', overflow: 'visible' }}
      >
        <line
          x1={pad.l}
          x2={width - pad.r}
          y1={baseline}
          y2={baseline}
          stroke={gridColor}
          strokeWidth={1}
        />

        {bars.map((b, i) => {
          const bx = x(i)
          const by = yScale(b.value)
          const h = Math.max(0, baseline - by)
          const active = hover?.i === i
          return (
            <g
              key={`${b.label}-${i}`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            >
              <motion.rect
                x={bx}
                y={by}
                width={x.bandwidth}
                height={h}
                rx={3}
                fill={color}
                fillOpacity={active ? 1 : 0.82}
                style={{ transformBox: 'fill-box', transformOrigin: 'bottom' }}
                initial={{ scaleY: 0 }}
                whileInView={{ scaleY: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: Math.min(i * 0.04, 0.6), ease: 'easeOut' }}
              />
              {x.bandwidth >= 22 && (
                <text
                  x={bx + x.bandwidth / 2}
                  y={height - 9}
                  textAnchor="middle"
                  fill={axisColor}
                  fontSize={10.5}
                >
                  {b.label}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      <ChartTooltip x={hover?.x ?? 0} y={hover?.y ?? 0} visible={hover !== null}>
        {hover !== null && bars[hover.i] ? (
          <>
            <strong>
              {formatValue(bars[hover.i].value)}
              {valueSuffix}
            </strong>
            <span style={{ opacity: 0.7 }}>{bars[hover.i].label}</span>
          </>
        ) : null}
      </ChartTooltip>
    </div>
  )
}
