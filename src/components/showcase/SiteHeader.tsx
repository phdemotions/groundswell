import { PROFILE } from '@/lib/profile'

import { BrandMark, ShareIcon } from './icons'
import { ShareButton } from './ShareButton'

export function SiteHeader() {
  return (
    <div className="gs-top-wrap">
      <div className="gs-inner">
        <div className="gs-top">
          <div className="gs-brand">
            <BrandMark className="gs-mark" />
            <div>
              <b>{PROFILE.name}</b>
              <div className="who">{PROFILE.title}</div>
            </div>
          </div>
          <nav className="gs-topnav" aria-label="Showcase sections">
            <a href="#work">The work</a>
            <a href="#next">Shipping next</a>
            <a href="#about">About</a>
            <ShareButton className="cta cta--ghost cta--sm menu">
              Share <ShareIcon width={13} height={13} />
            </ShareButton>
          </nav>
        </div>
      </div>
    </div>
  )
}
