/**
 * Bounded-concurrency limiter — U4 (KTD3).
 *
 * The plan's cited cron learning is explicit that an unbounded
 * `Promise.all` / `Promise.allSettled` fan-out is the scaling cliff: it opens
 * one in-flight request per item at once, so a tracked list that grows past a
 * handful of repos blows the GitHub secondary rate limit and the function
 * budget simultaneously. `runBounded` caps the number of workers running at any
 * instant at `limit` and pulls the next item only when a worker frees up.
 *
 * Result contract — a per-item ENVELOPE, never a throw for a single failure:
 *
 *   { ok: true,  value: R }      — the worker resolved
 *   { ok: false, error: unknown } — the worker threw / rejected
 *
 * One item throwing does NOT abort the batch: its slot records `{ok:false}` and
 * the remaining items keep running. The caller (the capture route) inspects the
 * envelope to decide per-repo success/failure and whether the whole batch was
 * all-ok (the watchdog-clock advance condition). Results are returned in INPUT
 * order regardless of completion order, so `results[i]` always corresponds to
 * `items[i]`.
 *
 * AbortSignal ownership: this limiter is signal-agnostic by design. The capture
 * route builds an `AbortController` with an abort budget and passes the signal
 * into the GitHubClient *inside the worker closure* — so abort threading lives
 * with the I/O, not the scheduler. An aborted in-flight `fetch` rejects, which
 * the limiter captures as an `{ok:false}` envelope like any other failure.
 *
 * Mirrors the `runBounded` signature/envelope shape from
 * `summer93/tools/vercel/lib/game-events.ts`.
 */

/** A per-item result envelope. A single failure never throws out of the batch. */
export type BoundedResult<R> =
  | { ok: true; value: R }
  | { ok: false; error: unknown }

/**
 * Run `worker` over `items` with at most `limit` invocations in flight at once.
 *
 * @param items   The work items, in priority order.
 * @param limit   Max concurrent workers. Clamped to `[1, items.length]` — a
 *                non-positive or oversized limit can never starve or over-fan.
 * @param worker  Async unit of work. Receives the item and its input index. It
 *                OWNS any AbortSignal threading (close over the signal). It may
 *                throw/reject for a single item without aborting the batch.
 * @returns       Envelopes in INPUT order: `results[i]` is the outcome of
 *                `items[i]`.
 */
export async function runBounded<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<Array<BoundedResult<R>>> {
  const results = new Array<BoundedResult<R>>(items.length)

  // Empty input: nothing to do (and concurrency would clamp to 1 on a 0-length
  // list, spinning a worker that immediately exits — short-circuit instead).
  if (items.length === 0) return results

  let nextIndex = 0

  async function pull(): Promise<void> {
    // Each worker drains the shared cursor: grab the next index, run it, repeat.
    // The post-increment is single-threaded under the JS event loop, so no two
    // workers ever claim the same index.
    while (nextIndex < items.length) {
      const i = nextIndex++
      try {
        const value = await worker(items[i] as T, i)
        results[i] = { ok: true, value }
      } catch (error) {
        // Swallow into the envelope — one item's failure must not reject the
        // Promise.all below and tear down its sibling workers.
        results[i] = { ok: false, error }
      }
    }
  }

  const concurrency = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: concurrency }, () => pull()))
  return results
}

/** True when every envelope in a batch resolved successfully. */
export function allOk<R>(results: ReadonlyArray<BoundedResult<R>>): boolean {
  return results.every((r) => r.ok)
}
