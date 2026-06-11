import { Showcase } from '@/components/showcase/Showcase'
import { loadShowcaseStore } from '@/lib/store/read'
import { buildShowcaseModel } from '@/lib/store/view'

/**
 * Public showcase (U10). Loads the committed JSON store + derives the view-model
 * at build time (SSG), then renders the ported showcase. Every figure flows from
 * the capture pipeline — nothing hardcoded (Product invariant #1).
 */
export default async function Home() {
  const model = buildShowcaseModel(await loadShowcaseStore())
  return <Showcase model={model} />
}
