'use client'

/**
 * Entrance safety-net. The hero text uses a CSS entrance animation (.gs-rise);
 * a backgrounded tab can throttle it and leave the hero blank. After load (and on
 * regaining visibility) we add `.gs-loaded`, which forces the end-state. Charts
 * animate via motion and don't depend on this.
 */

import { useEffect } from 'react'

export function Reveal() {
  useEffect(() => {
    const reveal = () => document.documentElement.classList.add('gs-loaded')
    const timer = window.setTimeout(reveal, 2000)
    const onVisible = () => {
      if (!document.hidden) window.setTimeout(reveal, 1200)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return null
}
