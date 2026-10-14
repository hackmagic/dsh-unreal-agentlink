/**
 * The plugin-owned service: one call path from a tool to the editor and back.
 *
 * Everything the tools do funnels through `call()`, so the guarantees are stated
 * once instead of per-tool:
 *
 * 1. **Catalog gate.** An unmapped method is refused. Forwarding a typo into
 *    someone's editor is not a service.
 * 2. **Serialization gate**, before the wire (see `protocol/serialization.ts`).
 * 3. **Breaker + rate limit**, so an agent loop cannot grind the game thread.
 * 4. **Read cache**, per session, invalidated by that session's own writes.
 * 5. **Ledger**, for every mutating call, which is what makes rollback reportable.
 * 6. **Translation**, so a locale-dependent message never has to be parsed.
 *
 * ## On the cache's correctness
 *
 * It is TTL-bounded *and* invalidated on write *and* session-local. That is three
 * mechanisms for one feature, and all three are load-bearing: a shared cache would
 * let session A's stale read answer session B after B's write; a cache without
 * invalidation would survive the session's own change to the thing it cached;
 * without a TTL, an editor the user is driving by hand would go stale. The default
 * is short (2 s) for exactly that reason — the cache exists to collapse a burst of
 * duplicate reads inside one agent turn, not to remember the level across minutes.
 *
 * @module service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { UalBridge, type BridgeLogEntry, type BridgeStats } from './protocol/bridge.js'
import { CircuitBreaker, RateLimiter, type BreakerState } from './resilience/breaker.js'
import { SessionStore, filterLogs, type LogFilter, type LedgerEntry } from './sessions/state.js'
import { translate, type TranslatedError } from './errors/translate.js'
import {
  METHODS,
  BLACKLIST,
  METHOD_NAMES,
  isKnown,
  isMutating,
  cacheable,
  requiresOf,
  timeoutFor,
  type Risk,
} from './catalog/methods.js'
import { UalError } from './protocol/types.js'
import { stableKey } from './protocol/serialization.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonObject } from './protocol/types.js'
import type { ResolvedConfig } from './config.js'

/** The value every tool returns. `ok` mirrors the plugin's own success test. */
export interface CallValue {
  ok: boolean
  method: string
  /** Verbatim `result`. Never reshaped: an agent that reads `created[0].path`
   * against the plugin's docs must find `created[0].path` here. */
  result?: JsonValue
  code?: number
  error?: string
  hint?: string
  kind?: string
  details?: JsonValue
  local?: string
  elapsedMs?: number
  /** True when this answer came from the session read cache. */
  cached?: boolean
  /** Set when the failure means the editor may still be doing the work. */
  mayStillRun?: boolean
}

export interface CallRequest {
  method: string
  params?: Record<string, unknown>
  agent?: Agent
  /** The session key; a tool call always has one, tests may not. */
  session: string
  signal?: AbortSignal
  timeoutMs?: number
  /** Skip the read cache for this call. */
  noCache?: boolean
  /** A long call the caller has chosen deliberately (ual_task). */
  long?: boolean
}

export interface CallOutcome {
  value: CallValue
  /** Set when a mutating call was recorded in the session ledger. */
  ledger?: LedgerEntry
  translated?: TranslatedError
}

/**
 * Whether a 200/207 body actually means success.
 *
 * The plugin answers `200` on several paths where the operation **failed**:
 * `editor.undo`/`editor.redo` always send 200 and carry `result.error`;
 * `blueprint.compile` answers 200 with `ok:false` when the blueprint still has
 * errors; `pie.observe` always answers 200. Upstream's own DEVELOPING.md calls
 * this out as a defect class ("调用方拿到 `ok: true` 就以为成功了"), and the fix it
 * demands is on our side: never infer success from the code alone.
 *
 * `207` is partial success — some targets landed, others are in `failed[]`. That
 * is a success for the wire and a warning for the model, so it passes with a note
 * rather than being discarded as a transport error.
 */
/**
 * The plugin's own success test, in one place.
 *
 * Several handlers answer `200` with `result.ok === false` (editor.undo,
 * editor.redo, blueprint.compile, pie.observe), and 207 means partial — so
 * neither the code nor the body alone decides. Narrows the body to an object
 * first: a bare scalar result is a plain success with nothing to inspect.
 */
export function judge(result: JsonValue | undefined, code: number): { ok: boolean; partial: boolean } {
  if (result === undefined) return { ok: true, partial: false }
  const body: JsonObject | undefined =
    typeof result === 'object' && result !== null && !Array.isArray(result) ? result : undefined
  if (!body) return { ok: true, partial: code === 207 }
  if (body.ok === false) return { ok: false, partial: false }
  if (typeof body.error === 'string' && body.error.length > 0) return { ok: false, partial: false }
  return { ok: true, partial: code === 207 }
}

/** Transport-level failures the breaker counts; agent mistakes it must not. */
function transportOutcome(error: unknown): 'transport' | 'input' {
  const name = (error as { name?: string })?.name ?? ''
  if (name === 'UalCommandError') {
    const code = (error as { code?: number }).code
    // 500/501/503 are the editor's own failures; the 4xx family is our input.
    return code === 500 || code === 501 || code === 503 ? 'transport' : 'input'
  }
  if (name === 'BridgeTimeoutError' || name === 'EditorLostError' || name === 'QueueStalledError' || name === 'NoEditorError') {
    return 'transport'
  }
  if (name === 'SerializationError' || name === 'AbortError') return 'input'
  return 'transport'
}

export class UalService {
  readonly bridge: UalBridge
  readonly breaker: CircuitBreaker
  readonly limiter: RateLimiter
  readonly sessions: SessionStore
  readonly config: ResolvedConfig

  /** A short-lived memo of `system.get_project_info` capabilities per editor. */
  private readonly capabilities = new Map<string, { at: number; value: Record<string, boolean> }>()

  constructor(readonly ctx: Context, config: ResolvedConfig) {
    this.config = config
    this.bridge = new UalBridge({
      host: config.host,
      port: config.port,
      timeoutMs: config.timeoutMs,
      logCapacity: config.logCapacity,
      logMinLevel: config.logMinLevel,
    })
    this.breaker = new CircuitBreaker({
      threshold: config.breakerThreshold,
      cooldownMs: config.breakerCooldownMs,
    })
    this.limiter = new RateLimiter({ perSecond: config.rateLimitRps, maxQueue: config.rateLimitQueue })
    this.sessions = new SessionStore({ cacheTtlMs: config.cacheTtlMs, cacheMaxEntries: config.cacheMaxEntries })
    this.bridge.setNoteSink(message => this.ctx.logger('ualink').info(message))
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.bridge.listen()
    // An editor that vanishes must drop its cached capability probe, or a
    // reconnect under the same project name inherits the old build's flags.
    this.bridge.on(event => {
      if (event.type === 'editor-lost') {
        this.capabilities.delete(event.session.sessionId)
        for (const state of this.sessions.all()) if (state.editor === event.session.sessionId) state.cache.clear()
      }
    })
  }

  async stop(): Promise<void> {
    this.limiter.drain()
    await this.bridge.stop()
  }

  // ── the one call path ────────────────────────────────────────────────────

  /** @throws never: failures come back inside {@link CallValue}, translated. */
  async call(request: CallRequest): Promise<CallOutcome> {
    const { method, session } = request
    const startedAt = Date.now()

    // 1. catalog gate
    if (!isKnown(method)) {
      const blocked = Object.hasOwn(BLACKLIST, method) ? BLACKLIST[method] : undefined
      const translated: TranslatedError = {
        kind: 'unknown-method',
        error: blocked ? `"${method}" is not available in UnrealAgentLink` : `UnrealAgentLink does not implement "${method}"`,
        hint: blocked ?? `ual_tools lists the ${METHOD_NAMES.length} methods this bridge knows. Anything else returns 404 on the wire, so it is refused here first.`,
        retryable: false,
      }
      return { value: { ok: false, method, ...shape(translated) }, translated }
    }

    // 2. required keys, checked locally so the failure names the key
    const missing = requiresOf(method).filter(key => request.params?.[key] === undefined)
    if (missing.length > 0) {
      const translated: TranslatedError = {
        kind: 'bad-params',
        error: `"${method}" requires ${missing.map(key => `"${key}"`).join(', ')}`,
        hint: `ual_schema { method: "${method}" } gives every key this handler reads and every key it returns.`,
        retryable: false,
      }
      return { value: { ok: false, method, ...shape(translated) }, translated }
    }

    // 3. read cache (session-local, only for cacheable reads, never for `long`)
    const useCache = !request.noCache && cacheable(method) && !request.long && !isMutating(method)
    const cacheKey = `${method}:${session}:${stableKey(request.params)}`
    if (useCache) {
      const hit = this.sessions.cacheGet(session, cacheKey)
      if (hit !== undefined) {
        return { value: { ...(hit as CallValue), cached: true, elapsedMs: Date.now() - startedAt } }
      }
    }

    // 4. breaker gate
    try {
      this.breaker.acquire()
    } catch (error) {
      const translated = translate(error, method)
      return { value: { ok: false, method, ...shape(translated) }, translated }
    }
    if (!this.breaker.admit()) {
      const translated = translate(new Error('the circuit is half-open and already probing'), method)
      this.breaker.release()
      return { value: { ok: false, method, ...shape(translated), local: 'circuit-open' }, translated }
    }

    try {
      // 5. rate limit: queue rather than fail, so a fan-out still completes.
      if (this.limiter.enabled) {
        try {
          await this.limiter.acquire()
        } catch (error) {
          const translated = translate(error, method)
          return { value: { ok: false, method, ...shape(translated), local: 'rate-limited' }, translated }
        }
      }

      const timeoutMs = timeoutFor(method, this.config.timeoutMs, request.timeoutMs)
      const reply = await this.bridge.send({
        method,
        params: request.params,
        timeoutMs,
        signal: request.signal,
        long: request.long,
        ...(this.editorTarget(session) ? { editor: this.editorTarget(session) } : {}),
      })
      const result = reply.result
      // Bound once and reused below: the reply's code is the wire's own verdict,
      // and it is what the caller sees next to `ok` so they can tell a 207
      // partial from a clean 200.
      const code = reply.code

      // A 200/207 reply is not necessarily a success: see `judge`.
      const { ok, partial } = judge(result, code)

      // Ledger for anything that changed something — recorded on the wire success,
      // because a command that failed at the transport level did not touch the
      // editor, but one that answered `ok:false` may have changed it partially and
      // the ledger must not pretend it did not.
      let ledger: LedgerEntry | undefined
      if (isMutating(method) && (ok || partial)) {
        ledger = this.sessions.record(session, method, result)
        this.sessions.invalidate(session)
        this.maybePushLocks()
      }

      if (!ok) {
        this.breaker.record('input')
        const message =
          typeof result === 'object' && result !== null && !Array.isArray(result) && typeof result.error === 'string' && result.error.length > 0
            ? result.error
            : 'the editor reported a failure'
        const translated = translate(new Error(message), method)
        return {
          value: {
            ok: false,
            method,
            result,
            code,
            ...shape(translated),
            elapsedMs: Date.now() - startedAt,
          },
          translated,
        }
      }

      this.breaker.record('ok')
      const value: CallValue = {
        ok: true,
        method,
        result,
        code,
        elapsedMs: Date.now() - startedAt,
        ...(partial ? { partial: true, note: `partial success (207): some targets failed — read failed/skipped/unmatched in result` } : {}),
      }
      if (useCache) this.sessions.cacheSet(session, cacheKey, value, method)
      return { value, ledger }
    } catch (error) {
      const outcome = transportOutcome(error)
      this.breaker.record(outcome, error instanceof Error ? error.message : String(error))
      const translated = translate(error, method, await this.noEditorHint())
      const code = (error as { code?: number })?.code
      const mayStillRun = (error as { mayStillRun?: boolean })?.mayStillRun === true
      return {
        value: {
          ok: false,
          method,
          ...shape(translated),
          ...(code !== undefined ? { code } : {}),
          ...(mayStillRun ? { mayStillRun: true } : {}),
          elapsedMs: Date.now() - startedAt,
        },
        translated,
      }
    } finally {
      this.breaker.release()
    }
  }

  /** Several calls in one turn. Serial by construction (the game thread is). */
  async callMany(requests: CallRequest[]): Promise<CallOutcome[]> {
    const out: CallOutcome[] = []
    for (const request of requests) out.push(await this.call(request))
    return out
  }

  // ── editor binding ───────────────────────────────────────────────────────

  private editorTarget(session: string): string | undefined {
    return this.sessions.peek(session)?.editor
  }

  /**
   * Bind a session to one editor.
   * @param pin false clears the binding so the session follows a lone editor again.
   */
  bind(session: string, editor: string | undefined, pin: boolean): { ok: boolean; error?: string; editors: BridgeStats['editors'] } {
    const state = this.sessions.state(session)
    const stats = this.bridge.stats()
    if (editor === undefined) {
      state.editor = undefined
      state.pinned = false
      state.cache.clear()
      return { ok: true, editors: stats.editors }
    }
    const match = stats.editors.find(
      entry => entry.sessionId === editor || entry.project?.toLowerCase() === editor.toLowerCase() || entry.projectPath?.toLowerCase().includes(editor.toLowerCase()),
    )
    if (!match) return { ok: false, error: `no connected editor matches "${editor}"`, editors: stats.editors }
    state.editor = match.sessionId
    state.pinned = pin
    // Bound editor changed: cached reads answered about the other project.
    state.cache.clear()
    return { ok: true, editors: stats.editors }
  }

  /** The one hint that needs a round trip: how to get an editor connected. */
  private async noEditorHint(): Promise<string | undefined> {
    const stats = this.bridge.stats()
    if (stats.editors.length > 0) return undefined
    return `Nothing is connected to ws://${stats.host}:${stats.port}. Open the project in Unreal Editor with the UnrealAgentLink plugin enabled — it dials in on its own and retries every 5 s. If UEBox desktop is running it owns this port; either close it or set "port" in this plugin's config and launch UE with -UALServer=ws://127.0.0.1:<port>.`
  }

  // ── capabilities ─────────────────────────────────────────────────────────

  /**
   * `system.get_project_info`'s capability flags, memoized per editor.
   *
   * A missing flag is `false`. The plugin's header says older builds do not
   * declare what they cannot do, so an absent key read as `true` would send the
   * agent into an unsupported path.
   */
  async capabilitiesFor(session: string): Promise<Record<string, boolean>> {
    const target = this.editorTarget(session)
    const cacheKey = target ?? 'default'
    const hit = this.capabilities.get(cacheKey)
    if (hit && Date.now() - hit.at < this.config.cacheTtlMs * 10) return hit.value
    const outcome = await this.call({ method: 'system.get_project_info', session, noCache: true })
    const raw = outcome.value.result as { capabilities?: Record<string, unknown> } | undefined
    const flags: Record<string, boolean> = {}
    for (const key of ['blueprint_require_empty', 'material_fail_if_exists', 'python']) {
      flags[key] = raw?.capabilities?.[key] === true
    }
    this.capabilities.set(cacheKey, { at: Date.now(), value: flags })
    return flags
  }

  // ── locks ────────────────────────────────────────────────────────────────

  private lastPushedLocks = ''
  private pushingLocks: Promise<boolean> | undefined

  /**
   * Push the merged lock table, at most once per tick and only when it changed.
   *
   * `enforced` is deliberately never sent: it marks the underlying files
   * read-only, and UE's Save All skips read-only packages silently — a bridge
   * that crashed mid-session would leave the user unable to save with no clue
   * from the editor.
   */
  maybePushLocks(): void {
    const merged = this.sessions.mergedLocks()
    const signature = merged.join('\n')
    if (signature === this.lastPushedLocks) return
    if (this.pushingLocks) return // coalesce: the pending push will carry the new union
    this.lastPushedLocks = signature
    this.pushingLocks = this.bridge
      .send({ method: 'locks.set', params: { paths: merged, level_locked: false }, timeoutMs: 10_000, long: true })
      .then(() => true)
      .catch(() => {
        // A failed push must be retryable, or the badges desync permanently.
        this.lastPushedLocks = ''
        return false
      })
      .finally(() => {
        this.pushingLocks = undefined
      })
  }

  /**
   * Push now and report whether the editor holds the current table.
   *
   * An unchanged signature means an earlier push already carried it, so that
   * counts as pushed. A failed send does not — the caller must be able to say
   * "not confirmed" rather than claim a badge the editor never drew.
   */
  async pushLocksNow(): Promise<boolean> {
    this.maybePushLocks()
    if (!this.pushingLocks) return this.lastPushedLocks !== ''
    return await this.pushingLocks
  }

  /**
   * Whether the editor is known to hold the current lock table. An unchanged
   * signature counts as pushed, because an earlier send carried it.
   */
  locksPushed(): boolean {
    return this.lastPushedLocks !== '' && this.lastPushedLocks === this.sessions.mergedLocks().join('\n')
  }

  setLocks(session: string, paths: string[], release: string[]): { locked: number } {
    const state = this.sessions.state(session)
    for (const path of paths) state.locks.add(path)
    for (const path of release) state.locks.delete(path)
    this.maybePushLocks()
    return { locked: this.sessions.mergedLocks().length }
  }

  clearLocks(session: string): number {
    const state = this.sessions.peek(session)
    if (state) state.locks.clear()
    this.maybePushLocks()
    return this.sessions.mergedLocks().length
  }

  // ── logs ─────────────────────────────────────────────────────────────────

  logs(filter: LogFilter = {}): BridgeLogEntry[] {
    return filterLogs(this.bridge.ringLogs, filter)
  }

  /** The newest seq currently held, which is what a caller stores as its cursor. */
  latestLogSeq(): number {
    const ring = this.bridge.ringLogs
    return ring.length > 0 ? ring[ring.length - 1]!.seq : 0
  }

  // ── status ───────────────────────────────────────────────────────────────

  status(session: string): {
    listening: boolean
    url: string
    editors: BridgeStats['editors']
    bound?: string
    pinned: boolean
    breaker: { state: BreakerState; retryAfterMs: number; reason: string }
    rate: { perSecond: number; queued: number }
    cache: { entries: number; ttlMs: number }
    steps: number
    locks: number
    logs: { retained: number; forwarded: boolean }
    stale: string[]
    pending: number
    pendingMethods: string[]
    orphaned: string[]
  } {
    const stats = this.bridge.stats()
    const state = this.sessions.peek(session)
    return {
      listening: stats.listening,
      url: `ws://${stats.host}:${stats.port}`,
      editors: stats.editors,
      ...(state?.editor ? { bound: state.editor } : {}),
      pinned: state?.pinned === true,
      breaker: { ...this.breaker.snapshot(), retryAfterMs: this.breaker.retryAfterMs },
      rate: this.limiter.snapshot(),
      cache: this.sessions.cacheStats(session),
      steps: state?.ledger.length ?? 0,
      locks: state?.locks.size ?? 0,
      logs: { retained: stats.logsRetained, forwarded: this.config.logForwardingEnabled },
      stale: this.bridge.staleEditors().map(entry => entry.sessionId),
      pending: stats.pending,
      pendingMethods: stats.pendingMethods,
      orphaned: stats.orphanedMethods,
    }
  }

  /** Everything the model can call, filtered for a compact listing. */
  toolList(filter?: string): Array<{ method: string; risk: Risk; summary: string; blocking?: boolean; warning?: string }> {
    const needle = filter?.toLowerCase()
    return METHOD_NAMES.filter(method => {
      if (!needle) return true
      const spec = METHODS[method]!
      return method.includes(needle) || spec.summary.toLowerCase().includes(needle)
    }).map(method => {
      const spec = METHODS[method]!
      return {
        method,
        risk: spec.risk,
        summary: spec.summary,
        ...(spec.blocking ? { blocking: true } : {}),
        ...(spec.warning ? { warning: spec.warning } : {}),
      }
    })
  }
}

function shape(translated: TranslatedError): Partial<CallValue> {
  return {
    error: translated.error,
    hint: translated.hint,
    kind: translated.kind,
    ...(translated.facts ? { details: translated.facts } : {}),
    ...(translated.kind === 'no-editor' || translated.kind === 'timeout' ? { local: translated.kind } : {}),
  }
}

/** Re-exported so the tools package does not import the error class directly. */
export { UalError }