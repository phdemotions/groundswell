'use client'

/**
 * BarChart — U9. Vertical bars (the per-release download bars). `motion` grows
 * each bar from the baseline (scaleY), staggered, whileInView once. Supports
 * per-bar color, value labels on selected bars, and major-version GROUP BANDS —
 * all driven by the (general, data-derived) chart spec from view.ts, never
 * hardcoded.
 *
 * Token-agnostic: colors arrive as props/per-bar. Headline stat numbers live in
 * HTML on the page (a11y); the chart is role="img" + aria-label.
 */

import { motion } from 'motion/react'
import { useState } from 'react'

import { ChartTooltip } from './ChartTooltip'
import { bandScale, linearScale, niceMax } from './scales'

export interface BarDatum {
  label: string
  value: number
  /** Per-bar fill (defaults to the chart `color`). */
  color?: string
  /** Print the value above this bar. */
  showValue?: boolean
}

export interface BarGroup {
  label: string
  sublabel?: string
  fromIndex: number
  toIndex: number
  color?: string
}

export interface BarChartProps {
  bars: BarDatum[]
  ariaLabel: string
  groups?: BarGroup[]
  width?: number
  height?: number
  color?: string
  gridColor?: string
  axisColor?: string
  formatValue?: (v: number) => string
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
  groups = [],
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

  const hasGroups = groups.length > 0
  const pad = { t: 22, r: 8, b: hasGroups ? 52 : 30, l: 8 }
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
          strokeWidth={1.2}
        />

        {bars.map((b, i) => {
          const bx = x(i)
          const by = yScale(b.value)
          const h = Math.max(0, baseline - by)
          const fill = b.color ?? color
          const active = hover?.i === i
          return (
            <g
              key={`${b.label}-${i}`}
              style={{ cursor: 'pointer' }}
              onMouseEnter={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            >
              {b.showValue && b.value > 0 ? (
                <text
                  x={bx + x.bandwidth / 2}
                  y={by - 8}
                  textAnchor="middle"
                  fill={fill}
                  fontFamily="var(--mono)"
                  fontWeight={600}
                  fontSize={12}
                >
                  {formatValue(b.value)}
                </text>
              ) : null}
              <motion.rect
                x={bx}
                y={by}
                width={x.bandwidth}
                height={h}
                rx={3}
                fill={fill}
                fillOpacity={active ? 1 : 0.88}
                style={{ transformBox: 'fill-box', transformOrigin: 'bottom' }}
                initial={{ scaleY: 0 }}
                whileInView={{ scaleY: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: Math.min(i * 0.04, 0.6), ease: 'easeOut' }}
              />
              {x.bandwidth >= 22 ? (
                <text
                  x={bx + x.bandwidth / 2}
                  y={baseline + 16}
                  textAnchor="middle"
                  fill={axisColor}
                  fontFamily="var(--mono)"
                  fontSize={10.5}
                >
                  {b.label}
                </text>
              ) : null}
            </g>
          )
        })}

        {groups.map((g) => {
          const gx0 = x(g.fromIndex)
          const gx1 = x(g.toIndex) + x.bandwidth
          const cx = (gx0 + gx1) / 2
          const text = g.sublabel ? `${g.label} · ${g.sublabel}` : g.label
          return (
            <g key={`${g.label}-${g.fromIndex}`}>
              <line
                x1={gx0 + 2}
                x2={gx1 - 2}
                y1={baseline + 28}
                y2={baseline + 28}
                stroke={g.color ?? axisColor}
                strokeWidth={1}
                opacity={0.4}
              />
              <text
                x={cx}
                y={baseline + 43}
                textAnchor="middle"
                fill={g.color ?? axisColor}
                fontFamily="var(--mono)"
                fontSize={10}
                letterSpacing="0.06em"
              >
                {text.toUpperCase()}
              </text>
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
