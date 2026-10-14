/**
 * The two promises in the README that had to be renegotiated with reality:
 * per-session undo rollback, and protecting the editor from the agent.
 *
 * Both are pinned here because a regression in either is invisible in normal
 * use — the undo tests pass on a single-session run and only fail when two
 * agents share an editor, and the breaker only fails when the editor is already
 * in trouble.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import { SessionStore, filterLogs, notifierFor } from '../src/sessions/state.js'
import { CircuitBreaker, CircuitOpenError, RateLimiter, RateLimitedError } from '../src/resilience/breaker.js'
import type { BridgeLogEntry } from '../src/protocol/bridge.js'

// ── LIFO undo ───────────────────────────────────────────────────────────────

describe('SessionStore: rollback is only claimed when it is a LIFO suffix', () => {
  const store = () => new SessionStore({ cacheTtlMs: 2000, cacheMaxEntries: 16 })

  it('refuses to roll back a session that never did anything', () => {
    const sessions = store()
    expect(sessions.canRollbackLifo('ghost')).toBe(false)
    expect(sessions.steps('ghost')).toBe(0)
  })

  it('allows rollback for the only session that acted', () => {
    const sessions = store()
    sessions.record('a', 'actor.spawn', { count: 3 })
    expect(sessions.canRollbackLifo('a')).toBe(true)
    expect(sessions.steps('a')).toBe(1)
  })

  it('refuses when another session acted after ours — undo would take theirs', () => {
    const sessions = store()
    sessions.record('a', 'actor.spawn', { count: 3 })
    sessions.record('b', 'actor.destroy', { count: 1 })
    expect(sessions.canRollbackLifo('a')).toBe(false)
    expect(sessions.canRollbackLifo('b')).toBe(true)
  })

  it('allows rollback after the interleaving session finishes', () => {
    const sessions = store()
    sessions.record('a', 'actor.spawn', { count: 3 })
    sessions.record('b', 'actor.destroy', { count: 1 })
    sessions.drop('b')
    expect(sessions.canRollbackLifo('a')).toBe(true)
  })

  it('does not let a peer session that only read clear the way', () => {
    const sessions = store()
    sessions.record('a', 'actor.spawn', { count: 3 })
    sessions.state('b') // exists, but recorded nothing
    expect(sessions.canRollbackLifo('a')).toBe(true)
  })

  it('numbers steps per session and globally across sessions', () => {
    const sessions = store()
    const first = sessions.record('a', 'actor.spawn', { count: 2 })
    const second = sessions.record('b', 'content.delete', {})
    const third = sessions.record('a', 'actor.destroy', { count: 1 })
    expect([first.step, first.global]).toEqual([1, 1])
    expect([second.step, second.global]).toEqual([1, 2])
    expect([third.step, third.global]).toEqual([2, 3])
  })

  it('names the packages it touched, from whichever key the method answered with', () => {
    const sessions = store()
    const fromPackages = sessions.record('a', 'content.move', { packages: ['/Game/Actors', '/Game/Props'] })
    const fromAffected = sessions.record('a', 'editor.save_all', { affected_packages: ['/Game/Maps/Main'] })
    const fromNested = sessions.record('a', 'actor.spawn', { created: [{ path: '/Game/Actors/Cube' }] })
    expect(fromPackages.packages).toEqual(['/Game/Actors', '/Game/Props'])
    expect(fromAffected.packages).toEqual(['/Game/Maps/Main'])
    expect(fromNested.packages).toEqual(['/Game/Actors/Cube'])
  })

  it('builds a rollback-report title that carries the count', () => {
    const sessions = store()
    expect(sessions.record('a', 'actor.spawn', { count: 3 }).title).toBe('actor.spawn (3)')
    expect(sessions.record('a', 'editor.undo', {}).title).toBe('editor.undo')
  })

  it('clearing a ledger does not create the session it cleared', () => {
    const sessions = store()
    sessions.clearLedger('never-seen')
    expect(sessions.all()).toHaveLength(0)
    sessions.record('a', 'actor.spawn', {})
    sessions.clearLedger('a')
    expect(sessions.canRollbackLifo('a')).toBe(false)
    expect(sessions.all()).toHaveLength(1)
  })
})

describe('SessionStore: locks are merged, not per-caller', () => {
  it('pushes the union of every live session and drops only what the ending session claimed', () => {
    const sessions = new SessionStore({ cacheTtlMs: 2000, cacheMaxEntries: 16 })
    sessions.state('a').locks = new Set(['/Game/Actors/Cube.uasset'])
    sessions.state('b').locks = new Set(['/Game/Materials/M_Rock.uasset'])
    expect(sessions.mergedLocks()).toEqual([
      '/Game/Actors/Cube.uasset',
      '/Game/Materials/M_Rock.uasset',
    ])
    sessions.drop('a')
    expect(sessions.mergedLocks()).toEqual(['/Game/Materials/M_Rock.uasset'])
  })

  it('keeps a shared path locked until the last session claiming it leaves', () => {
    const sessions = new SessionStore({ cacheTtlMs: 2000, cacheMaxEntries: 16 })
    sessions.state('a').locks = new Set(['/Game/Actors/Cube.uasset'])
    sessions.state('b').locks = new Set(['/Game/Actors/Cube.uasset'])
    sessions.drop('a')
    expect(sessions.mergedLocks()).toEqual(['/Game/Actors/Cube.uasset'])
    sessions.drop('b')
    expect(sessions.mergedLocks()).toEqual([])
  })
})

describe('SessionStore: the read cache is per session and expires', () => {
  it('never serves one session a read another session cached', () => {
    const sessions = new SessionStore({ cacheTtlMs: 2000, cacheMaxEntries: 16 })
    sessions.cacheSet('a', 'actor.list:all', { count: 1 }, 'actor.list')
    expect(sessions.cacheGet('b', 'actor.list:all')).toBeUndefined()
    expect(sessions.cacheGet('a', 'actor.list:all')).toEqual({ count: 1 })
  })

  it('expires a read once the TTL passes', () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const sessions = new SessionStore({ cacheTtlMs: 100, cacheMaxEntries: 16 })
    sessions.cacheSet('a', 'k', 'v', 'actor.list')
    vi.spyOn(Date, 'now').mockReturnValue(now + 101)
    expect(sessions.cacheGet('a', 'k')).toBeUndefined()
  })

  it('evicts the oldest entry once the entry cap is exceeded', () => {
    vi.restoreAllMocks()
    const sessions = new SessionStore({ cacheTtlMs: 60_000, cacheMaxEntries: 2 })
    sessions.cacheSet('a', 'old', 1, 'm')
    sessions.cacheSet('a', 'mid', 2, 'm')
    sessions.cacheSet('a', 'new', 3, 'm')
    expect(sessions.cacheGet('a', 'old')).toBeUndefined()
    expect(sessions.cacheGet('a', 'new')).toBe(3)
  })
})

// ── log filtering ───────────────────────────────────────────────────────────

const log = (seq: number, level: string, category: string, text: string): BridgeLogEntry =>
  ({ seq, at: seq, session: 's', level, category, text, project: '/Game/Main' }) as BridgeLogEntry

describe('filterLogs: severity is ordered, not alphabetical', () => {
  const ring: BridgeLogEntry[] = [
    log(1, 'Log', 'LogUAL', 'spawned Cube'),
    log(2, 'Error', 'LogUAL', 'compile failed'),
    log(3, 'Warning', 'LogTemp', 'heavy load'),
    log(4, 'Display', 'LogUAL', 'editor ready'),
  ]

  it('keeps Error and Warning when the floor is Warning, and drops the chatter', () => {
    const kept = filterLogs(ring, { minLevel: 'Warning' }).map(entry => entry.seq)
    expect(kept).toEqual([2, 3])
  })

  it('treats an exact level as a floor, not an equality match', () => {
    expect(filterLogs(ring, { level: 'Error' }).map(entry => entry.seq)).toEqual([2])
  })

  it('filters by category substring and by text substring, case-insensitively', () => {
    expect(filterLogs(ring, { category: 'logual' }).map(entry => entry.seq)).toEqual([1, 2, 4])
    expect(filterLogs(ring, { contains: 'COMPILE' }).map(entry => entry.seq)).toEqual([2])
  })

  it('returns only lines after the cursor, so the caller can page', () => {
    expect(filterLogs(ring, { sinceSeq: 2 }).map(entry => entry.seq)).toEqual([3, 4])
  })

  it('returns the most recent lines up to the limit, not the oldest', () => {
    expect(filterLogs(ring, { limit: 2 }).map(entry => entry.seq)).toEqual([3, 4])
  })
})

describe('notifierFor: a disposed agent is normal teardown, not an error', () => {
  it('reports false when there is no agent to notify', () => {
    expect(notifierFor(undefined)('editor connected')).toBe(false)
  })

  it('injects and reports true on the happy path', () => {
    let seen: string | undefined
    const agent = {
      inject: (message: { content: Array<{ text: string }> }) => {
        seen = message.content[0]?.text
      },
    }
    expect(notifierFor(agent as never)('editor connected')).toBe(true)
    expect(seen).toBe('editor connected')
  })

  it('swallows the throw from an agent that went away mid-teardown', () => {
    const agent = {
      inject: () => {
        throw new Error('fiber disposed')
      },
    }
    expect(notifierFor(agent as never)('too late')).toBe(false)
  })
})

// ── breaker ─────────────────────────────────────────────────────────────────

describe('CircuitBreaker: only the editor being in trouble trips it', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })
  afterEach(() => vi.useRealTimers())

  it('opens after the threshold of consecutive transport failures', () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    breaker.record('transport', 'timeout')
    breaker.record('transport', 'timeout')
    expect(breaker.current).toBe('closed')
    breaker.record('transport', 'timeout')
    expect(breaker.current).toBe('open')
    expect(breaker.snapshot().reason).toBe('timeout')
  })

  it('does not count the agent making bad calls as the editor being sick', () => {
    const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 1000 })
    for (let index = 0; index < 10; index += 1) breaker.record('input', 'unknown method')
    expect(breaker.current).toBe('closed')
    expect(breaker.snapshot().consecutive).toBe(0)
  })

  it('a single success clears the consecutive count', () => {
    const breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 })
    breaker.record('transport')
    breaker.record('transport')
    breaker.record('ok')
    breaker.record('transport')
    breaker.record('transport')
    expect(breaker.current).toBe('closed')
  })

  it('refuses calls while open and says when it will probe again', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 5000 })
    breaker.record('transport', 'the editor stopped replying')
    expect(() => breaker.acquire()).toThrow(CircuitOpenError)
    expect(breaker.retryAfterMs).toBe(5000)
    expect(breaker.reason).toBe('the editor stopped replying')
  })

  it('moves to half-open after the cooldown and re-opens immediately if the probe fails', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 })
    breaker.record('transport', 'editor lost')
    vi.advanceTimersByTime(1000)
    expect(breaker.current).toBe('half-open')
    expect(breaker.admit()).toBe(true)
    breaker.release()
    breaker.record('transport', 'probe failed')
    expect(breaker.current).toBe('open')
  })

  it('closes again once the probe succeeds', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 })
    breaker.record('transport')
    vi.advanceTimersByTime(1000)
    breaker.record('ok')
    expect(breaker.current).toBe('closed')
    expect(breaker.snapshot().consecutive).toBe(0)
  })

  it('admits exactly one probe at a time in half-open', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 })
    breaker.record('transport')
    vi.advanceTimersByTime(1000)
    expect(breaker.admit()).toBe(true)
    expect(breaker.admit()).toBe(false)
    breaker.release()
    expect(breaker.admit()).toBe(true)
  })

  it('reset() is the manual recovery path for the user who fixed the editor', () => {
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 1000 })
    breaker.record('transport', 'timeout')
    breaker.reset()
    expect(breaker.current).toBe('closed')
    expect(breaker.reason).toBe('')
  })
})

// ── rate limiter ────────────────────────────────────────────────────────────

describe('RateLimiter: spaced, queued, and never unbounded', () => {
  it('is a no-op when disabled', async () => {
    const limiter = new RateLimiter({ perSecond: 0 })
    expect(limiter.enabled).toBe(false)
    await expect(limiter.acquire()).resolves.toBeTypeOf('function')
  })

  it('queues a call made inside the same interval and releases it one interval later', async () => {
    const limiter = new RateLimiter({ perSecond: 10 }) // intervalMs = 100
    const started = Date.now()
    await limiter.acquire()
    const queued = limiter.acquire()
    expect(limiter.snapshot().queued).toBe(1)
    await queued
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    expect(limiter.snapshot().queued).toBe(0)
  })

  it('rejects rather than queue without bound', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const limiter = new RateLimiter({ perSecond: 1, maxQueue: 1 })
    await limiter.acquire()
    const queued = limiter.acquire()
    await expect(limiter.acquire()).rejects.toThrow(RateLimitedError)
    expect(limiter.snapshot().queued).toBe(1)
    vi.useRealTimers()
    void queued
  })

  it('drain() wakes every waiter with an error when the bridge goes away', async () => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const limiter = new RateLimiter({ perSecond: 1, maxQueue: 8 })
    await limiter.acquire()
    const waiting = limiter.acquire()
    const failed = waiting.catch((error: Error) => error.name)
    limiter.drain()
    expect(await failed).toBe('RateLimitedError')
    expect(limiter.snapshot().queued).toBe(0)
    vi.restoreAllMocks()
  })
})
