import type { PipelineItem } from '@/lib/store/view'

export function Pipeline({ pipeline }: { pipeline: PipelineItem[] }) {
  if (pipeline.length === 0) return null
  return (
    <section id="next" className="gs-inner gs-pipeline" aria-label="What's shipping next">
      <div className="gs-sec-head">
        <div className="gs-sec-head-l">
          <span className="kicker">Shipping next</span>
          <h2>What&rsquo;s in the workshop</h2>
        </div>
        <p>
          The rest of the toolkit, honestly staged. No traction claimed before it&rsquo;s
          earned — these are listed by what they do and where they are.
        </p>
      </div>

      <div className="gs-pipe-grid">
        {pipeline.map((item) => (
          <div className="gs-pipe" key={item.displayName}>
            <div className="pipe-head">
              <span className="nm">{item.displayName}</span>
              <span className="tracking--soft">
                <span className="dot" />
                {item.status}
              </span>
            </div>
            <p className="blurb">{item.tagline}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
