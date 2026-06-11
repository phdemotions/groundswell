import { ImageResponse } from 'next/og'

import { loadShowcaseStore } from '@/lib/store/read'
import { buildShowcaseModel } from '@/lib/store/view'

export const alt = 'Research tools I build and ship — real GitHub traction'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
// Required for `output: 'export'` — generate the OG image once at build time.
export const dynamic = 'force-static'

// Generated at build time (static export). Reads the same real model the page does,
// so the shared-link card shows live totals — falls back to a number-free card.
export default async function OpengraphImage() {
  let downloads = 0
  let stars = 0
  try {
    const model = buildShowcaseModel(await loadShowcaseStore())
    downloads = model.hero.totalDownloads
    stars = model.hero.totalStars
  } catch {
    // number-free fallback
  }

  const stat = (value: string, label: string) => (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ fontSize: 60, fontWeight: 700, color: '#1E8C7A' }}>{value}</div>
      <div style={{ fontSize: 22, color: '#5A655E' }}>{label}</div>
    </div>
  )

  return new ImageResponse(
    (
      <div
        style={{
          height: '100%',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#FBFAF7',
          padding: 72,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <div style={{ width: 56, height: 56, borderRadius: 16, background: '#0E574C' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 30, fontWeight: 600, color: '#1A1C1A' }}>Josh Gonzales</div>
            <div style={{ fontSize: 22, color: '#5A655E' }}>PhD Candidate</div>
          </div>
        </div>

        <div style={{ fontSize: 72, fontWeight: 700, color: '#1A1C1A', letterSpacing: -1 }}>
          I build and ship research tools.
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 56 }}>
            {downloads > 0 ? stat(downloads.toLocaleString('en-US'), 'downloads') : null}
            {stars > 0 ? stat(String(stars), 'GitHub stars') : null}
          </div>
          <div style={{ fontSize: 22, color: '#828D86' }}>real GitHub traction</div>
        </div>
      </div>
    ),
    { ...size }
  )
}
