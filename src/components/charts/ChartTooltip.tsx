'use client'

/**
 * Chart tooltip — U9. Rendered via a portal to document.body (per CLAUDE
 * conventions: tooltips never live inside the SVG — they'd be clipped by overflow
 * and can't escape the chart's stacking context). Controlled: the chart owns the
 * hover state + viewport coords and passes `visible` + `x`/`y` (clientX/clientY).
 */

import { type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ChartTooltipProps {
  /** Viewport X (clientX) of the anchor. */
  x: number
  /** Viewport Y (clientY) of the anchor. */
  y: number
  visible: boolean
  children: ReactNode
  className?: string
}

export function ChartTooltip({ x, y, visible, children, className }: ChartTooltipProps) {
  // The tooltip only appears on a client-side hover (`visible` flips true after an
  // interaction), so the portal never runs during SSR — a plain guard suffices.
  if (!visible || typeof document === 'undefined') return null

  return createPortal(
    <div
      role="tooltip"
      className={className}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        transform: 'translate(-50%, calc(-100% - 12px))',
        pointerEvents: 'none',
        zIndex: 60,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        padding: '6px 10px',
        borderRadius: 8,
        background: 'rgba(26, 28, 26, 0.96)',
        color: '#fff',
        fontSize: 12,
        lineHeight: 1.2,
        whiteSpace: 'nowrap',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.18)',
      }}
    >
      {children}
    </div>,
    document.body
  )
}
