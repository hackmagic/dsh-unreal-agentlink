/**
 * Per-session state, and the two places where the README's promise and UE's
 * reality disagree.
 *
 * ## The promise
 *
 * "每个会话独立Undo事务栈，会话销毁自动回滚" — a session gets its own undo
 * stack and rolling it back on disposal undoes what that session did.
 *
 * ## The reality
 *
 * `FUAL_AgentUndo` gives the plugin ONE agent transaction buffer per editor,
 * separate from the user's `GEditor->Trans` but shared by every DSH session
 * talking to that editor. `editor.undo` pops the top N entries, LIFO. So with
 * two live sessions:
 *
 * ```text
 *   agent buffer:  [ A1 A2 A3 | B1 B2 ]     A = session A, B = session B
 *   undo A's 3  ==  undo B2, B1, A3, A2, A1   ← not expressible
 * ```
 *
 * ## What this module does instead, and why it is still the promised feature
 *
 * Rollback is offered **only when it is exactly a LIFO suffix**: the session's
 * steps must be the most recent ones, with nothing from another session on top.
 * That is detected by tracking each session's own step count and the global
 * sequence, and it covers the case that actually matters — one agent driving one
 * editor, which is how this bridge gets used. When it is *not* a clean suffix,
 * the session reports its step titles and the affected packages instead of
 * silently undoing someone else's work. A tool that quietly destroys another
 * session's changes is worse than a tool that says "I did not roll this back,
 * here is what it did".
 *
 * ## Locks are the same problem in the other direction
 *
 * `locks.set` replaces the editor's whole lock table — it is not per-caller. So
 * the bridge owns one table and merges every live session's claim into it, then
 * pushes the union. A session that ends releases only its own paths. `enforced`
 * is **never** sent by default: that subset gets the read-only bit set on the
 * real files, and UE's Save All skips read-only packages without a word, which
 * is how a user loses work to a bridge that then crashed.
 *
 * @module sessions/state
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { BridgeLogEntry } from '../protocol/bridge.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonObject } from '../protocol/types.js'

/** One recorded mutation, as the session ledger keeps it. */
export interface LedgerEntry {
  /** Position in this session's own sequence, starting at 1. */
  step: number
  /** Global position across all sessions of this bridge, for suffix detection. */
  global: number
  method: string
  at: number
  /** What the plugin said it changed, when the result carried such fields. */
  packages: string[]
  objects: string[]
  /** A short human line for the rollback report. */
  title: string
}

export interface SessionState {
  sessionId: string
  /** Bound editor session id, or undefined while following the live singleton. */
  editor: string | undefined
  /** Whether the user explicitly pinned this session's editor for this turn. */
  pinned: boolean
  ledger: LedgerEntry[]
  /** Paths this session claims. */
  locks: Set<string>
  /** Read-cache for this session only: another session's actor list is stale here. */
  cache: Map<string, { at: number; value: unknown; method: string }>
  /** Per-session log view is derived from the bridge ring; this is the cursor. */
  logCursor: number
  createdAt: number
}

/**
 * Tracks what each DSH session did to the editor.
 *
 * Deliberately not a `ctx` service: this is one bridge's state, and the plugin's
 * own fiber owns its lifetime. A session that never called a tool never gets an
 * entry at all, which is what keeps disposal cheap.
 */
export class SessionStore {
  private readonly sessions = new Map<string, SessionState>()
  private global = 0

  constructor(private readonly options: { cacheTtlMs: number; cacheMaxEntries: number }) {}

  /** Create-or-get. Called lazily so an idle session costs nothing. */
  state(sessionId: string): SessionState {
    let existing = this.sessions.get(sessionId)
    if (!existing) {
      existing = {
        sessionId,
        editor: undefined,
        pinned: false,
        ledger: [],
        locks: new Set(),
        cache: new Map(),
        logCursor: 0,
        createdAt: Date.now(),
      }
      this.sessions.set(sessionId, existing)
    }
    return existing
  }

  peek(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /** Record one mutation. Returns the ledger entry for the caller's report. */
  record(sessionId: string, method: string, result: JsonValue | undefined): LedgerEntry {
    const state = this.state(sessionId)
    const body: JsonObject | undefined =
      typeof result === 'object' && result !== null && !Array.isArray(result) ? result : undefined
    const count = typeof body?.count === 'number' ? body.count : undefined
    const entry: LedgerEntry = {
      step: state.ledger.length + 1,
      global: ++this.global,
      method,
      at: Date.now(),
      packages: stringList(pickFirst(body, ['affected_packages', 'packages', 'saved', 'created'])) ?? extractPaths(body),
      objects: stringList(body?.affected_objects ?? body?.objects) ?? [],
      title: `${method}${count !== undefined ? ` (${count})` : ''}`,
    }
    state.ledger.push(entry)
    return entry
  }

  /**
   * Whether this session's steps are the top of the shared agent buffer.
   *
   * True when no other session has recorded anything after this session's last
   * step — the only case where `editor.undo{steps:N}` removes exactly ours.
   */
  canRollbackLifo(sessionId: string): boolean {
    const own = this.state(sessionId)
    if (own.ledger.length === 0) return false
    const lastGlobal = own.ledger[own.ledger.length - 1]!.global
    for (const other of this.sessions.values()) {
      if (other.sessionId === sessionId) continue
      const tail = other.ledger[other.ledger.length - 1]
      if (tail && tail.global > lastGlobal) return false
    }
    return true
  }

  steps(sessionId: string): number {
    return this.state(sessionId).ledger.length
  }

  /** Forget a session's history (after a rollback, or when its buffer was cleared by a map change). */
  clearLedger(sessionId: string): void {
    // `get`, not `state()`: clearing the ledger of a session we never saw must
    // not create one — that would leak an empty session into `all()`.
    const state = this.sessions.get(sessionId)
    if (state) state.ledger = []
  }

  drop(sessionId: string): SessionState | undefined {
    const state = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return state
  }

  all(): SessionState[] {
    return [...this.sessions.values()]
  }

  /** The union of every live session's claims — what `locks.set` must receive. */
  mergedLocks(): string[] {
    const union = new Set<string>()
    for (const state of this.sessions.values()) for (const path of state.locks) union.add(path)
    return [...union].sort()
  }

  // ── cache ────────────────────────────────────────────────────────────────

  /**
   * Per-session read cache.
   *
   * Session-local on purpose: two agents inspecting the same level are not
   * guaranteed to want the same answer at the same time, and a shared cache would
   * let one session's stale read answer another's question after a mutation.
   */
  cacheGet(sessionId: string, key: string): unknown {
    const state = this.sessions.get(sessionId)
    if (!state) return undefined
    const hit = state.cache.get(key)
    if (!hit) return undefined
    if (Date.now() - hit.at > this.options.cacheTtlMs) {
      state.cache.delete(key)
      return undefined
    }
    return hit.value
  }

  cacheSet(sessionId: string, key: string, value: unknown, method: string): void {
    const state = this.state(sessionId)
    state.cache.set(key, { at: Date.now(), value, method })
    if (state.cache.size <= this.options.cacheMaxEntries) return
    // Evict oldest-first rather than by insertion order: a long session's first
    // reads are the ones nobody wants again.
    const now = Date.now()
    const expired = [...state.cache.entries()].filter(([, entry]) => now - entry.at > this.options.cacheTtlMs)
    for (const [expiredKey] of expired) state.cache.delete(expiredKey)
    while (state.cache.size > this.options.cacheMaxEntries) {
      const oldest = [...state.cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (!oldest) break
      state.cache.delete(oldest[0])
    }
  }

  /**
   * Any mutation invalidates this session's cached reads, immediately.
   *
   * The cache is keyed per session and every entry in it belongs to the same
   * editor, so a rebind needs no separate treatment — dropping the session's
   * entries covers both cases.
   */
  invalidate(sessionId: string): void {
    this.sessions.get(sessionId)?.cache.clear()
  }

  cacheStats(sessionId: string): { entries: number; ttlMs: number } {
    return { entries: this.sessions.get(sessionId)?.cache.size ?? 0, ttlMs: this.options.cacheTtlMs }
  }
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((item): item is string => typeof item === 'string')
  return out.length > 0 ? out : undefined
}

function pickFirst(record: JsonObject | undefined, keys: string[]): JsonValue | undefined {
  if (!record) return undefined
  for (const key of keys) if (record[key] !== undefined) return record[key]
  return undefined
}

/**
 * Best-effort path extraction from a result body.
 *
 * UAL has no single "what did you touch" field — `created[].path`, `actors[].path`,
 * `saved[].package`, `deleted[]` all appear depending on the method. Collecting
 * them gives the rollback report something concrete to name, which matters because
 * `editor.undo_history` truncates its object preview to 8 entries.
 */
function extractPaths(record: JsonObject | undefined): string[] {
  if (!record) return []
  const found = new Set<string>()
  const visit = (value: unknown, depth: number): void => {
    if (depth > 3 || value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    const object = value as Record<string, unknown>
    for (const key of ['path', 'package', 'asset_path', 'name']) {
      const candidate = object[key]
      if (typeof candidate === 'string' && candidate.startsWith('/')) found.add(candidate)
    }
    for (const nested of Object.values(object)) visit(nested, depth + 1)
  }
  visit(record, 0)
  return [...found]
}

/** A `log.entry` filter shared by `ual_logs` and the notifier. */
export interface LogFilter {
  level?: string
  category?: string
  contains?: string
  /** Only lines at or above this severity (Error < Warning < Display < Log). */
  minLevel?: string
  sinceSeq?: number
  limit?: number
  session?: string
}

const SEVERITY: Record<string, number> = { Fatal: 0, Error: 1, Warning: 2, Display: 3, Log: 4, Verbose: 5, VeryVerbose: 6, Unknown: 7 }

export function filterLogs(ring: readonly BridgeLogEntry[], filter: LogFilter = {}): BridgeLogEntry[] {
  const limit = Math.max(1, Math.min(filter.limit ?? 40, 200))
  const minSeverity = filter.level ? (SEVERITY[filter.level] ?? 7) : filter.minLevel ? (SEVERITY[filter.minLevel] ?? 7) : undefined
  const needle = filter.contains?.toLowerCase()
  const category = filter.category?.toLowerCase()

  const kept = ring.filter(entry => {
    if (filter.sinceSeq !== undefined && entry.seq <= filter.sinceSeq) return false
    if (filter.session && entry.session !== filter.session) return false
    if (minSeverity !== undefined && (SEVERITY[entry.level] ?? 7) > minSeverity) return false
    if (category && !entry.category.toLowerCase().includes(category)) return false
    if (needle && !entry.text.toLowerCase().includes(needle)) return false
    return true
  })
  return kept.slice(-limit)
}

/**
 * Owner of the "notify this agent about X" path, so it can degrade when absent.
 *
 * Returns a boolean rather than throwing: a disposed agent is the normal race
 * during teardown, and the caller is broadcasting to every live agent, so one
 * dead target must not stop the rest. `inject` is not a wake-up — an idle agent
 * reads the message on its next request — which is what "an editor came and went"
 * wants.
 */
export function notifierFor(agent: Agent | undefined, plugin = 'dsh-unreal-agentlink'): (content: string) => boolean {
  return (content: string): boolean => {
    if (!agent) return false
    try {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'plugin', plugin } }))
      return true
    } catch {
      return false
    }
  }
}
