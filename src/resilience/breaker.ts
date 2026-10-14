/**
 * Protection for the editor process, not for our own.
 *
 * ## Why a bridge needs a breaker at all
 *
 * The thing on the other end of this socket is a user's Unreal Editor, running
 * commands synchronously on its game thread. An agent in a loop can issue a
 * hundred requests in a minute; a hundred requests against an editor that is
 * already hung is how you get a crash, a wedged game thread, and a lost
 * unsaved level. That is the actual failure this guards, and it is why
 * `rateLimitRps` and a breaker are in the project README rather than in the
 * "nice to have" column.
 *
 * ## What counts as a transport failure
 *
 * **Deliberately narrow.** The plugin returns 400/404/409/412 for bad input —
 * a wrong property name, a nonexistent path, a name collision, an ambiguous
 * class. Those are the agent's mistakes, and an agent that makes ten of them in
 * a row is *working*, not killing the editor. Opening the breaker on those would
 * punish exactly the exploratory behaviour that makes the bridge useful.
 *
 * The breaker trips only on failures that indicate the editor itself is in
 * trouble: `BridgeTimeoutError` (it stopped replying), `EditorLostError` (it
 * went away), `QueueStalledError` (something ahead of us is still hanging),
 * send errors, and 500/501/503 (the plugin's own internal/capacity failures).
 *
 * ## Why tripping is also *informative*
 *
 * When the breaker is open, `ual_status` reports it as an explicit verdict with
 * the retry-after and the trip reason, rather than letting the model discover it
 * as an opaque "unavailable". A model that knows the editor stopped replying
 * will stop sending; a model that gets a generic error will retry, which is what
 * wedges the editor further.
 *
 * @module resilience
 */

export type TransportOutcome = 'ok' | 'transport' | 'input'

export interface BreakerOptions {
  /** Consecutive transport failures that open the circuit. */
  threshold?: number
  /** How long the circuit stays open before a single probe is allowed through. */
  cooldownMs?: number
  /** Probe success count required to close again (1 by default; a hung editor fails the probe). */
  successThreshold?: number
}

export type BreakerState = 'closed' | 'open' | 'half-open'

export class CircuitOpenError extends Error {
  readonly retryAfterMs: number
  readonly reason: string
  constructor(retryAfterMs: number, reason: string) {
    super(
      `the UnrealAgentLink circuit is open (${reason}); it will probe again in ${Math.ceil(retryAfterMs / 1000)}s — stop sending editor commands and re-check ual_status`,
    )
    this.name = 'CircuitOpenError'
    this.retryAfterMs = retryAfterMs
    this.reason = reason
  }
}

export class CircuitBreaker {
  private readonly threshold: number
  private readonly cooldownMs: number
  private readonly successThreshold: number

  private state: BreakerState = 'closed'
  private consecutive = 0
  private probeSuccesses = 0
  private openedAt = 0
  private lastReason = ''

  constructor(options: BreakerOptions = {}) {
    this.threshold = Math.max(1, options.threshold ?? 3)
    this.cooldownMs = Math.max(1000, options.cooldownMs ?? 30_000)
    this.successThreshold = Math.max(1, options.successThreshold ?? 1)
  }

  get current(): BreakerState {
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) this.state = 'half-open'
    return this.state
  }

  get retryAfterMs(): number {
    if (this.current !== 'open') return 0
    return Math.max(0, this.cooldownMs - (Date.now() - this.openedAt))
  }

  get reason(): string {
    return this.lastReason
  }

  /** @throws CircuitOpenError when the circuit will not admit this request. */
  acquire(): void {
    const state = this.current
    if (state === 'open') throw new CircuitOpenError(this.retryAfterMs, this.lastReason)
    // half-open admits exactly one probe at a time; see inFlightProbe below.
  }

  private inFlightProbe = 0

  /** Whether this call may proceed in the current state (half-open admits one). */
  admit(): boolean {
    if (this.current !== 'half-open') return true
    if (this.inFlightProbe > 0) return false
    this.inFlightProbe += 1
    return true
  }

  release(): void {
    this.inFlightProbe = Math.max(0, this.inFlightProbe - 1)
  }

  record(outcome: TransportOutcome, reason = ''): void {
    if (outcome === 'input') return // the agent's mistake, not the editor's health
    if (outcome === 'ok') {
      this.consecutive = 0
      if (this.current === 'half-open') {
        this.probeSuccesses += 1
        if (this.probeSuccesses >= this.successThreshold) this.close()
      }
      return
    }
    this.lastReason = reason || 'the editor stopped replying'
    if (this.current === 'half-open') {
      this.open('probe failed')
      return
    }
    this.consecutive += 1
    if (this.consecutive >= this.threshold) this.open(this.lastReason)
  }

  private open(reason: string): void {
    this.state = 'open'
    this.openedAt = Date.now()
    this.probeSuccesses = 0
    this.consecutive = this.threshold
    this.lastReason = reason || this.lastReason
  }

  private close(): void {
    this.state = 'closed'
    this.consecutive = 0
    this.probeSuccesses = 0
    this.inFlightProbe = 0
  }

  /** Manual reset after the user says the editor is back. */
  reset(): void {
    this.close()
    this.lastReason = ''
  }

  snapshot(): { state: BreakerState; consecutive: number; retryAfterMs: number; reason: string } {
    return { state: this.current, consecutive: this.consecutive, retryAfterMs: this.retryAfterMs, reason: this.lastReason }
  }
}

/**
 * A sliding-window limiter.
 *
 * Window, not token bucket: the goal is "no more than N *editor* commands per
 * second sustained", and the shape that protects a single-threaded game loop is
 * a rate, not a burst allowance. Waiting callers queue rather than fail, so an
 * agent that fans out ten spawns gets them all, just spaced.
 */
export interface RateLimiterOptions {
  perSecond?: number
  /** Never let the backlog grow unboundedly; beyond this, reject. */
  maxQueue?: number
}

export class RateLimitedError extends Error {
  readonly waitMs: number
  constructor(waitMs: number) {
    super(`the UnrealAgentLink rate limit is saturated (queue full); retry in ${Math.ceil(waitMs)}ms`)
    this.name = 'RateLimitedError'
    this.waitMs = waitMs
  }
}

export class RateLimiter {
  private readonly intervalMs: number
  private readonly maxQueue: number
  private stamps: number[] = []
  private tail: Array<{ resolve: (release: () => void) => void; reject: (error: Error) => void }> = []

  constructor(options: RateLimiterOptions = {}) {
    const perSecond = options.perSecond ?? 5
    this.intervalMs = perSecond <= 0 ? 0 : Math.ceil(1000 / Math.max(1, perSecond))
    this.maxQueue = options.maxQueue ?? 32
  }

  get enabled(): boolean {
    return this.intervalMs > 0
  }

  /** Resolve when the next slot is free; reject if the backlog is full. */
  async acquire(): Promise<() => void> {
    if (!this.enabled) return () => {}
    const now = Date.now()
    // Drop stamps older than one interval: the window is the interval itself.
    this.stamps = this.stamps.filter(stamp => now - stamp < Math.max(this.intervalMs, 1000))
    if (this.stamps.length === 0 || now - this.stamps[this.stamps.length - 1]! >= this.intervalMs) {
      this.stamps.push(now)
      return () => {}
    }
    if (this.tail.length >= this.maxQueue) throw new RateLimitedError(this.intervalMs)

    return new Promise<() => void>((resolve, reject) => {
      this.tail.push({ resolve, reject })
      this.schedule()
    })
  }

  private pumping = false
  private pumpId = 0

  /**
   * Space the queued waiters one interval apart.
   *
   * The first release is delayed by whatever is left of the current interval,
   * not fired at once — otherwise the very next call after a burst goes through
   * instantly and the limiter only starts working from the second queued call.
   */
  private schedule(): void {
    if (this.pumping || this.tail.length === 0) return
    this.pumping = true
    const id = ++this.pumpId
    const tick = (): void => {
      // A drain() superseded this pump: its timers must not release anything.
      if (id !== this.pumpId) return
      const next = this.tail.shift()
      if (!next) {
        this.pumping = false
        return
      }
      this.stamps.push(Date.now())
      next.resolve(() => {})
      setTimeout(tick, this.intervalMs).unref?.()
    }
    const last = this.stamps[this.stamps.length - 1]
    const wait = last === undefined ? 0 : Math.max(0, this.intervalMs - (Date.now() - last))
    setTimeout(tick, wait).unref?.()
  }

  /** Wake queued waiters with an error when the bridge is going away. */
  drain(): void {
    const waiting = this.tail
    this.tail = []
    this.pumping = false
    // Invalidates any timer still in flight from a previous pump.
    this.pumpId += 1
    for (const entry of waiting) entry.reject(new RateLimitedError(0))
  }

  snapshot(): { perSecond: number; queued: number; windowUsed: number } {
    return {
      perSecond: this.enabled ? Math.round(1000 / this.intervalMs) : 0,
      queued: this.tail.length,
      windowUsed: this.stamps.length,
    }
  }
}
