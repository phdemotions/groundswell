import { dayMonthYear } from '@/lib/format'
import { PROFILE } from '@/lib/profile'

import { ShareIcon } from './icons'
import { ShareButton } from './ShareButton'

export function Footer({ generatedAt }: { generatedAt: string | null }) {
  return (
    <footer id="about" className="gs-inner gs-foot">
      <div className="src">
        <b>How this is measured.</b> The figures here are real, pulled from the GitHub
        API. Stars are reconstructed from full history; release downloads are GitHub&rsquo;s
        own counts. <b>Daily download tracking starts when capture goes live</b> — until
        then the page shows the honest totals it has, not a curve it can&rsquo;t yet draw.
      </div>
      <div className="right">
        <span className="kicker kicker--bare" style={{ justifyContent: 'flex-end' }}>
          {generatedAt ? `Snapshot · ${dayMonthYear(generatedAt)}` : 'Snapshot pending'}
        </span>
        <div
          style={{
            marginTop: 'var(--s-4)',
            display: 'flex',
            gap: 'var(--s-3)',
            justifyContent: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <ShareButton className="cta">
            Share this page <ShareIcon width={14} height={14} />
          </ShareButton>
          <a className="cta cta--ghost" href={PROFILE.githubUrl} target="_blank" rel="noreferrer">
            View on GitHub ↗
          </a>
        </div>
      </div>
    </footer>
  )
}
