/** Display formatting helpers for the showcase (U10). */

/** Thousands-grouped integer, e.g. 1576 → "1,576". */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** ISO/day → "Jun 2026" (UTC). Empty string if unparseable. */
export function monthYear(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** ISO/day → "Jun '26" (UTC). Empty string if unparseable. */
export function monthShortYear(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}`
}

/** ISO/day → "11 Jun 2026" (UTC). Empty string if unparseable. */
export function dayMonthYear(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const d = new Date(ms)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}
