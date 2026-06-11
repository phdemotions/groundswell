import type { ShowcaseModel } from '@/lib/store/view'

import { Cadence } from './Cadence'
import { DataTable } from './DataTable'
import { Footer } from './Footer'
import { Hero } from './Hero'
import { Pipeline } from './Pipeline'
import { Reveal } from './Reveal'
import { SiteHeader } from './SiteHeader'

/**
 * The public showcase — composes the ported sections under `.gs`, fed entirely by
 * the derived view-model (no hardcoded figures). Server component; the charts +
 * Share/Reveal are the only client islands.
 */
export function Showcase({ model }: { model: ShowcaseModel }) {
  const lead =
    model.projects.find((p) => p.name === model.hero.leadProjectName) ??
    model.projects.at(0) ??
    null

  return (
    <div className="gs">
      <Reveal />
      <SiteHeader />
      <main id="work">
        {lead ? <Hero model={model} lead={lead} /> : null}
        {lead ? <Cadence lead={lead} /> : null}
        <Pipeline pipeline={model.pipeline} />
        <Footer generatedAt={model.generatedAt} />
      </main>
      <DataTable model={model} lead={lead} />
    </div>
  )
}
