# Groundswell — Next

**Branch:** `feat/scaffold-and-mockups` (own repo, unpushed; tree clean except untracked local preview copy + `.claude/`; build green).

**Mockup design gate — APPROVED** (Josh, 2026-06-10: "looks good enough").
Canonical mockup: `docs/mockups/2026-06-10-showcase-real.html` (preview port 4594) —
real numbers (citegeist 546 / 10★ / 16 releases), de-echoed, full-width, pixel-aligned,
quiet editorial "Shipping next" cards.

**Heavy build (U9→U10) HELD** pending **GS-002** recruiter validation — Josh's own plan
gate (don't build U10 against an unvalidated design). Next real action is GS-002 (Josh).

**On GS-002 pass, build the UI track** (each: implement → /simplify → /deslop → /thermo-nuclear → commit; mockup-first still applies to U11/U12 with a lighter gate):
U9 chart primitives (d3-shape + motion, barrel export) → U10 public showcase → U11 curation + auth (`proxy.ts`) → U12 private radar.

**Committed (Phase A + derived):** U1 scaffold · U2 schema/RLS · U3 client · U4 capture+watchdog · U5 mockups v1 · U7 backfill · U8 derived · real-numbers + 4-round polish + alignment + quiet Shipping-next mockup (`showcase-real.html`). Full `pnpm build` green.

**Blockers (Josh, manual):** GS-001 ops → live capture; GS-002 recruiters → U6.

**Before U9/U10:** fold the GS-007 conventions into `groundswell/CLAUDE.md`.
