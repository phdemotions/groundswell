/**
 * Placeholder landing page. The real public showcase ships in U10, gated by the
 * U5 design-system mockup approval and the U6 recruiter-validation decision.
 * Kept deliberately minimal so it carries no design debt for U5 to unwind.
 */
export default function Home() {
  return (
    <main style={{ padding: '4rem 1.5rem', maxWidth: '40rem', margin: '0 auto' }}>
      <h1 style={{ fontSize: '1.5rem', fontWeight: 600 }}>Groundswell</h1>
      <p style={{ marginTop: '0.75rem', color: '#555', lineHeight: 1.6 }}>
        Scaffold is live. The public showcase arrives in U10, after the design
        system (U5) and recruiter validation (U6).
      </p>
    </main>
  )
}
