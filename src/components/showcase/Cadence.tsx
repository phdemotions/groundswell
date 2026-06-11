import { BarChart } from '@/components/charts'
import { monthShortYear, monthYear } from '@/lib/format'
import { buildReleaseChart, type ShowcaseProject } from '@/lib/store/view'

export function Cadence({ lead }: { lead: ShowcaseProject }) {
  const chart = buildReleaseChart(lead.releaseBars)
  const first = lead.cadence.at(0)?.publishedAt ?? null
  const last = lead.cadence.at(-1)?.publishedAt ?? null
  const range = first && last ? `${monthShortYear(first)} → ${monthShortYear(last)}` : ''
  const v2 = lead.cadence.find((c) => /^v2\./.test(c.tag)) ?? null
  const v2Month = v2 ? monthYear(v2.publishedAt) : null

  return (
    <section className="gs-inner gs-cadence" aria-label="The real strength: how often it ships">
      <div className="gs-cadence-card">
        <div className="gs-cadence-grid">
          <div>
            <span className="kicker kicker--accent">How it ships</span>
            <h2 className="narr-head">
              <span className="em">{lead.releaseCount} releases</span> in about ten weeks.
            </h2>
            <p className="narr-lede">
              A <b>version 2 rewrite</b>{v2Month ? ` landed in ${v2Month}` : ' is the current line'}.
            </p>
            <p className="narr">
              Version 1 found its footing through April; the v2 rebuild shipped over a few
              days in June. Each bar is one release&rsquo;s downloads.
            </p>
          </div>

          <div className="gs-bars">
            <div className="gs-bars-head">
              <span className="t">Downloads per release</span>
              <span className="yr">{range}</span>
            </div>
            <BarChart
              bars={chart.bars}
              groups={chart.groups}
              ariaLabel={`Downloads per release across ${lead.releaseCount} releases shipped between ${range}.`}
              gridColor="var(--viz-grid)"
              axisColor="var(--color-ink-3)"
              height={300}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
