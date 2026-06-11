import type { SVGProps } from 'react'

/** Brand mark — the layered "swell" wave (server-safe inline SVG). */
export function BrandMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 28 28" fill="none" aria-hidden="true" {...props}>
      <rect width="28" height="28" rx="8" fill="#0E574C" />
      <path
        d="M4 19 C 8 19, 9 11, 14 11 C 19 11, 20 16, 24 16"
        stroke="#5FB6A6"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M4 22 C 8 22, 9 7, 14 7 C 19 7, 20 13, 24 13"
        stroke="#E8F4F1"
        strokeWidth="2.2"
        strokeLinecap="round"
        opacity=".85"
      />
    </svg>
  )
}

/** Download (down-arrow to a baseline). */
export function DownloadIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M8 11V2.5M8 11l-3-3M8 11l3-3M3 13.5h10"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Upward trend (momentum). */
export function TrendUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" {...props}>
      <path
        d="M6 9.5V2.5M6 2.5L2.5 6M6 2.5L9.5 6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** Share / external (diagonal arrow out of a box corner). */
export function ShareIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 14 14" fill="none" aria-hidden="true" {...props}>
      <path
        d="M4 10L10 4M10 4H5M10 4V9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
