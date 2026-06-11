'use client'

/**
 * AreaCurve — U9. A cumulative time-series area+line chart (the hero stars curve;
 * reused for downloads). `d3-shape` builds the smoothed paths; `motion` draws the
 * line in + fades the area. Animates on MOUNT (not whileInView) because the hero
 * is above the fold — a backgrounded tab's IntersectionObserver can fire late and
 * leave the hero blank, so mount-trigger is the robust choice here.
 *
 * Token-agnostic: colors come in as props so the page supplies design tokens.
 * Stat numbers are HTML elsewhere (a11y) — this SVG draws shapes only and carries
 * an aria-label summarizing the trend.
 */

import { motion } from 'motion/react'
import { useState } from 'react'

import { ChartTooltip } from './ChartTooltip'
import { areaPath, linePath, type PixelPoint } from './geometry'
import { linearScale, niceMax, ticks } from './scales'

export interface AreaCurvePoint {
  /** YYYY-MM-DD (UTC). */
  day: string
  value: number
}

export interface AreaCurveProps {
  points: AreaCurvePoint[]
  /** Required: summarizes the trend for screen readers. */
  ariaLabel: string
  width?: number
  height?: number
  /** Line + area color (pass a design token from the page). */
  color?: string
  gridColor?: string
  axisColor?: string
  formatValue?: (v: number) => string
  className?: string
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function monthLabel(day: string): string {
  const ms = Date.parse(day)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`
}

interface HoverState {
  i: number
  x: number
  y: number
}

export function AreaCurve({
  points,
  ariaLabel,
  width = 866,
  height = 320,
  color = 'currentColor',
  gridColor = 'rgba(0, 0, 0, 0.08)',
  axisColor = 'rgba(0, 0, 0, 0.45)',
  formatValue = (v) => v.toLocaleString('en-US'),
  className,
}: AreaCurveProps) {
  const [hover, setHover] = useState<HoverState | null>(null)

  const pad = { t: 16, r: 18, b: 28, l: 18 }
  const innerW = width - pad.l - pad.r
  const innerH = height - pad.t - pad.b
  const baseline = pad.t + innerH

  const xsMs = points.map((p) => Date.parse(p.day))
  const xMin = xsMs.length > 0 ? Math.min(...xsMs) : 0
  const xMaxRaw = xsMs.length > 0 ? Math.max(...xsMs) : 1
  const xMax = xMaxRaw === xMin ? xMin + 1 : xMaxRaw
  const yMax = niceMax(Math.max(1, ...points.map((p) => p.value)))

  const xScale = linearScale([xMin, xMax], [pad.l, pad.l + innerW])
  const yScale = linearScale([0, yMax], [baseline, pad.t])

  const pts: PixelPoint[] = points.map((p) => ({
    x: xScale(Date.parse(p.day)),
    y: yScale(p.value),
  }))
  const dLine = linePath(pts)
  const dArea = areaPath(pts, baseline)

  return (
    <div className={className} style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        width="100%"
        style={{ display: 'block', overflow: 'visible' }}
      >
        {ticks(yMax, 4).map((t) => (
          <line
            key={t}
            x1={pad.l}
            x2={width - pad.r}
            y1={yScale(t)}
            y2={yScale(t)}
            stroke={gridColor}
            strokeWidth={1}
          />
        ))}

        {dArea.length > 0 && (
          <motion.path
            d={dArea}
            fill={color}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.12 }}
            transition={{ duration: 0.8, ease: 'easeOut' }}
          />
        )}

        {dLine.length > 0 && (
          <motion.path
            d={dLine}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.1, ease: 'easeOut' }}
          />
        )}

        {pts.map((p, i) => (
          <g key={`${points[i].day}-${i}`}>
            <circle cx={p.x} cy={p.y} r={hover?.i === i ? 4.5 : 0} fill={color} />
            <circle
              cx={p.x}
              cy={p.y}
              r={14}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            />
          </g>
        ))}

        {points.length > 0 && (
          <>
            <text x={pad.l} y={height - 8} fill={axisColor} fontSize={11.5}>
              {monthLabel(points[0].day)}
            </text>
            <text
              x={width - pad.r}
              y={height - 8}
              fill={axisColor}
              fontSize={11.5}
              textAnchor="end"
            >
              {monthLabel(points[points.length - 1].day)}
            </text>
          </>
        )}
      </svg>

      <ChartTooltip x={hover?.x ?? 0} y={hover?.y ?? 0} visible={hover !== null}>
        {hover !== null && points[hover.i] ? (
          <>
            <strong>{formatValue(points[hover.i].value)}</strong>
            <span style={{ opacity: 0.7 }}>{monthLabel(points[hover.i].day)}</span>
          </>
        ) : null}
      </ChartTooltip>
    </div>
  )
}
