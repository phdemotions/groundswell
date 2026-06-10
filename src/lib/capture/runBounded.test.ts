import { describe, it, expect, vi } from 'vitest'
import { runBounded, allOk, type BoundedResult } from './runBounded'

/**
 * U4 bounded-concurrency contract tests (KTD3). Test-first: these pin the
 * limiter's guarantees the capture route depends on —
 *   • never more than `limit` workers in flight at once,
 *   • one item throwing leaves the others ok (the envelope captures the failure),
 *   • results come back in INPUT order,
 *   • an injected AbortSignal can be threaded through the worker closure and an
 *     aborted in-flight task surfaces as an {ok:false} envelope.
 * No live I/O — workers are in-memory async functions with controllable timing.
 */

/** A manually-resolvable promise, so a test can hold workers open mid-flight. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const ok = <R>(r: BoundedResult<R>): r is { ok: true; value: R } => r.ok

describe('runBounded — concurrency bound', () => {
  it('never exceeds the concurrency limit', async () => {
    const limit = 3
    const total = 12
    let inFlight = 0
    let maxInFlight = 0

    const items = Array.from({ length: total }, (_, i) => i)
    const results = await runBounded(items, limit, async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      // Yield to the event loop so siblings get a chance to start — this is
      // where an unbounded implementation would spike inFlight to `total`.
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return item * 2
    })

    expect(maxInFlight).toBeLessThanOrEqual(limit)
    expect(maxInFlight).toBe(limit) // saturates the budget with total > limit
    expect(results).toHaveLength(total)
    expect(results.every(ok)).toBe(true)
    expect(results.map((r) => (ok(r) ? r.value : null))).toEqual(
      items.map((i) => i * 2)
    )
  })

  it('clamps a limit larger than the item count (never over-fans)', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const items = [1, 2]
    await runBounded(items, 100, async (item) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight -= 1
      return item
    })
    expect(maxInFlight).toBeLessThanOrEqual(items.length)
  })

  it('treats a non-positive limit as 1 (never starves)', async () => {
    const items = [1, 2, 3]
    const seen: number[] = []
    const results = await runBounded(items, 0, async (item) => {
      seen.push(item)
      return item
    })
    expect(results.every(ok)).toBe(true)
    expect(seen).toEqual([1, 2, 3])
  })

  it('handles an empty item list without spinning a worker', async () => {
    const worker = vi.fn()
    const results = await runBounded([], 4, worker)
    expect(results).toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })
})

describe('runBounded — failure isolation (envelope)', () => {
  it('one item throwing leaves the others ok', async () => {
    const items = [0, 1, 2, 3, 4]
    const results = await runBounded(items, 2, async (item) => {
      if (item === 2) throw new Error('boom on 2')
      return item * 10
    })

    expect(results).toHaveLength(5)
    // The thrower is captured as {ok:false}; every sibling resolved.
    expect(results[2].ok).toBe(false)
    if (!results[2].ok) {
      expect(results[2].error).toBeInstanceOf(Error)
      expect((results[2].error as Error).message).toBe('boom on 2')
    }
    for (const i of [0, 1, 3, 4]) {
      expect(results[i].ok).toBe(true)
      expect(ok(results[i]) && results[i].value).toBe(i * 10)
    }
    expect(allOk(results)).toBe(false)
  })

  it('captures a rejected promise (not just a synchronous throw)', async () => {
    const items = ['a', 'b']
    const results = await runBounded(items, 2, async (item) => {
      if (item === 'b') return Promise.reject(new Error('async reject'))
      return item
    })
    expect(results[0].ok).toBe(true)
    expect(results[1].ok).toBe(false)
  })

  it('allOk is true only when every envelope resolved', async () => {
    const allGood = await runBounded([1, 2, 3], 2, async (x) => x)
    expect(allOk(allGood)).toBe(true)
  })
})

describe('runBounded — input ordering preserved under out-of-order completion', () => {
  it('returns results indexed by input position, not completion order', async () => {
    // Item 0 resolves LAST, item 2 resolves FIRST — yet results stay in order.
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()]
    const items = [0, 1, 2]

    const run = runBounded(items, 3, async (item) => gates[item].promise)

    gates[2].resolve(202)
    gates[0].resolve(200)
    gates[1].resolve(201)

    const results = await run
    expect(results.map((r) => (ok(r) ? r.value : null))).toEqual([200, 201, 202])
  })
})

describe('runBounded — AbortSignal threaded through the worker closure', () => {
  it('an aborted in-flight task surfaces as an {ok:false} envelope while siblings finish', async () => {
    const controller = new AbortController()
    const items = ['fast', 'slow']

    // The worker closes over the controller's signal — exactly how the capture
    // route hands the abort budget to the GitHubClient. A "fetch" that observes
    // the signal rejects with an AbortError-shaped error.
    const results = await runBounded(items, 2, async (item) => {
      if (item === 'fast') return 'done'
      // Simulate a long fetch that the abort budget cancels.
      return new Promise<string>((_resolve, reject) => {
        if (controller.signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        controller.signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
        // Fire the abort on the next tick to interrupt this in-flight task.
        setTimeout(() => controller.abort(), 1)
      })
    })

    expect(results[0].ok).toBe(true)
    expect(ok(results[0]) && results[0].value).toBe('done')
    expect(results[1].ok).toBe(false)
    if (!results[1].ok) {
      expect((results[1].error as Error).name).toBe('AbortError')
    }
    expect(allOk(results)).toBe(false)
  })

  it('passes the input index to the worker', async () => {
    const items = ['x', 'y', 'z']
    const indices: number[] = []
    await runBounded(items, 1, async (_item, index) => {
      indices.push(index)
      return index
    })
    expect(indices).toEqual([0, 1, 2])
  })
})
