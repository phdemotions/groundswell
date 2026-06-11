'use client'

/**
 * Share button — uses the Web Share API where available (mobile), falling back to
 * copying the page URL to the clipboard. Client component (needs navigator).
 */

import type { ReactNode } from 'react'

export function ShareButton({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  function share() {
    if (typeof window === 'undefined') return
    const url = window.location.href
    if (typeof navigator.share === 'function') {
      void navigator.share({ url }).catch(() => {})
    } else if (navigator.clipboard) {
      void navigator.clipboard.writeText(url).catch(() => {})
    }
  }

  return (
    <button type="button" className={className} onClick={share}>
      {children}
    </button>
  )
}
