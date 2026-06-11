import { AreaCurve } from '@/components/charts'
import { formatCount, monthShortYear } from '@/lib/format'
import { PROFILE } from '@/lib/profile'
import type { ShowcaseModel, ShowcaseProject } from '@/lib/store/view'

import { DownloadIcon, TrendUpIcon } from './icons'

export function Hero({ model, lead }: { model: ShowcaseModel; lead: ShowcaseProject }) {
  const starsPoints = lead.starsCurve.map((c) => ({ day: c.day, value: c.cumulative }))

  return (
    <header className="gs-inner gs-hero">
      <h1 className="gs-statement gs-rise" style={{ animationDelay: '.12s' }}>
        {PROFILE.statementLead} <span className="em">{PROFILE.statementEm}</span>.
      </h1>

      <div className="gs-anchor-block">
        <div className="gs-anchor gs-rise" style={{ animationDelay: '.2s' }}>
          <div className="lead-label">
            <DownloadIcon />
            {lead.displayName} · downloaded
          </div>
          <span className="gs-mega">{formatCount(model.hero.totalDownloads)}</span>
          <p className="caption">{lead.tagline}</p>
          <div className="gs-modifier">
            {lead.latestRelease ? (
              <span className="delta">
                <TrendUpIcon />
                {lead.latestRelease.tag} · {monthShortYear(lead.latestRelease.publishedAt)}
              </span>
            ) : null}
            {lead.visibility === 'public' ? (
              <span className="aside">open-source</span>
            ) : null}
          </div>
        </div>

        <div className="gs-curve-wrap gs-rise" style={{ animationDelay: '.28s' }}>
          <div className="gs-curve-head">
            <span className="t">GitHub stars over time</span>
            <span className="yr">{formatCount(lead.stars)} ★</span>
          </div>
          <AreaCurve
            points={starsPoints}
            ariaLabel={`${lead.displayName} GitHub stars over time, rising to ${lead.stars}, reconstructed from history.`}
            color="var(--viz-cat-1)"
            gridColor="var(--viz-grid)"
            axisColor="var(--color-ink-3)"
            valueSuffix=" ★"
          />
          <div className="gs-curve-foot">
            <span className="mid">reconstructed from GitHub history</span>
          </div>
        </div>
      </div>
    </header>
  )
}
