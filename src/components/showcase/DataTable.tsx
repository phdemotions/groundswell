import { dayMonthYear, monthYear } from '@/lib/format'
import type { ShowcaseModel, ShowcaseProject } from '@/lib/store/view'

/**
 * Visually-hidden, screen-reader-accessible table of the real figures. The charts
 * are role="img" with summary labels; this gives AT users the exact numbers.
 */
export function DataTable({
  model,
  lead,
}: {
  model: ShowcaseModel
  lead: ShowcaseProject | null
}) {
  return (
    <table className="sr-only">
      <caption>
        Groundswell traction data (real, from GitHub
        {model.generatedAt ? `, snapshot ${dayMonthYear(model.generatedAt)}` : ''})
      </caption>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Value</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>
        {lead ? (
          <>
            <tr>
              <td>{lead.displayName} total release downloads</td>
              <td>{lead.downloads.latest}</td>
              <td>{lead.tagline}</td>
            </tr>
            <tr>
              <td>{lead.displayName} GitHub stars</td>
              <td>{lead.stars}</td>
              <td>Reconstructed from full history</td>
            </tr>
            <tr>
              <td>{lead.displayName} releases shipped</td>
              <td>{lead.releaseCount}</td>
              <td>Including a version 2 rewrite</td>
            </tr>
            {lead.releaseBars.map((b) => (
              <tr key={b.tag}>
                <td>Downloads — {b.tag}</td>
                <td>{b.downloads}</td>
                <td>{b.publishedAt ? monthYear(b.publishedAt) : ''}</td>
              </tr>
            ))}
          </>
        ) : null}
        {model.pipeline.map((p) => (
          <tr key={p.displayName}>
            <td>{p.displayName}</td>
            <td>—</td>
            <td>{p.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
