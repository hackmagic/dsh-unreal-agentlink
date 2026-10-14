/**
 * The UnrealAgentLink bridge: a WebSocket **server** that UE editors dial into.
 *
 * ## Direction, because it is the part everyone gets wrong
 *
 * The UE plugin is the client. `StartupModule()` does
 * `FUAL_NetworkManager::Get().Init("ws://127.0.0.1:17860")` and retries every
 * 5 s forever. So this class *listens*; it never dials out. An editor appears
 * the moment someone opens the project and disappears when they close it.
 *
 * ## What the serial queue is and why it exists
 *
 * Every command runs **synchronously on UE's game thread** — `ProcessMessage`
 * hops onto a one-shot ticker and calls the handler inline. One slow command
 * (`blueprint.compile_all`, an Interchange import, `pie.run`) blocks every other
 * request, the 10 s heartbeat, and log forwarding with it. Pipelining three
 * requests into that editor does not parallelize anything; it builds a queue
 * whose head is a request the caller has already given up on.
 *
 * So `send()` serializes per editor and the default timeout is generous (180 s,
 * matching what UEBox's own box side documents). What we deliberately do *not*
 * do is pretend to be a job queue: long work belongs to `ual_task` / `ctx.jobs`,
 * which owns that shape properly.
 *
 * ## Cancellation is honest about its limits
 *
 * `AbortSignal` stops *our* wait. There is no UAL message that stops *UE*
 * mid-command — no `cancel_task` exists (the original draft's `getTask` /
 * `cancelTask` were invented). On timeout we record the orphaned method, so
 * `ual_status` can say "the editor may still be running X" and a later caller
 * is not quietly queued behind it. Pretending otherwise would let an agent
 * build on a state it believes was rolled back.
 *
 * @module protocol/bridge
 */

import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { randomUUID } from 'node:crypto'

import {
  UAL_DEFAULT_PORT,
  UAL_VERSION,
  type PendingRequest,
  type ProjectInfoPayload,
  type UalEvent,
  type UalEventMethod,
  type UalMessage,
  type UalResponse,
  type UalSession,
} from './types.js'
import { toSerializable } from './serialization.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One UE log line as pushed by `log.entry`. */
export interface BridgeLogEntry {
  seq: number
  at: number
  /** Bridge session id of the editor that sent it. */
  session: string
  /** `payload.text` — the message. */
  text: string
  /** `payload.category` — e.g. `LogBlueprintUserMessages`. */
  category: string
  /** `payload.level` — `Fatal` | `Error` | `Warning` | `Display` | `Log` | `Verbose` | `VeryVerbose` | `Unknown`. */
  level: string
  project?: string
}

export interface BridgeOptions {
  host?: string
  port?: number
  /** Default per-request timeout, in ms. UAL imposes no command timeout of its own. */
  timeoutMs?: number
  /** Ring capacity for forwarded `log.entry` lines. */
  logCapacity?: number
  /** Drop log lines more verbose than this. */
  logMinLevel?: string
  /** A lost batch of this size or more is reported once, not N times. */
  lostBatchSize?: number
}

export interface SendOptions {
  method: string
  params?: Record<string, unknown>
  timeoutMs?: number
  signal?: AbortSignal
  /** Project / session selector; see {@link UalBridge.resolve}. */
  editor?: string
  /**
   * This call is expected to be slow. It still serializes, but it does not
   * refuse to queue behind an orphaned method — a long command is the caller's
   * own choice, not a surprise.
   */
  long?: boolean
}

/** Emitted for the plugin's diagnostics surface. */
export interface BridgeStats {
  listening: boolean
  host: string
  port: number
  editors: Array<{
    sessionId: string
    project?: string
    projectPath?: string
    engineVersion?: string
    pluginBuild?: string
    level?: string
    runMode?: string
    connectedAt: number
    lastSeenAt: number
    heartbeats: number
    stale: boolean
  }>
  pending: number
  pendingMethods: string[]
  /** Methods whose reply we gave up on and UE cannot be told to stop. */
  orphanedMethods: string[]
  logsRetained: number
  sent: number
  replies: number
  failures: number
  sendRejected: number
}

const DEFAULT_TIMEOUT = 180_000
/** UEBox's box side declares an editor dead after 45 s of silence. */
const HEARTBEAT_STALE_MS = 45_000

/** Ascending verbosity, for the `logMinLevel` filter. */
const LEVEL_ORDER: Record<string, number> = {
  Fatal: 0,
  Error: 1,
  Warning: 2,
  Display: 3,
  Log: 4,
  Verbose: 5,
  VeryVerbose: 6,
  Unknown: 7,
}

/**
 * Every `evt` method this bridge acknowledges, keyed by the `UalEventMethod`
 * union so the two cannot drift: adding an arm to the union fails this
 * declaration until the bridge says what it does with it, and the handler in
 * `handleEvent` is typed against the same set.
 *
 * `'ignore'` is an explicit answer, not an omission — UE pushes more event names
 * than any one consumer cares about, and saying so here is what keeps the
 * vocabulary honest instead of silently falling through a `default`.
 */
const EVENT_HANDLING = {
  'project.info': 'identify',
  'project.closed': 'close',
  'system.heartbeat': 'heartbeat',
  'log.entry': 'log',
  'content.import_folder': 'import',
  'content.import_assets': 'import',
} satisfies Record<UalEventMethod, 'identify' | 'close' | 'heartbeat' | 'log' | 'import'>

export class EditorLostError extends Error {
  readonly method: string
  readonly sessionId: string
  readonly pendingMethods: string[]
  constructor(method: string, sessionId: string, pendingMethods: string[]) {
    super(`the Unreal Editor running "${method}" disconnected before it replied`)
    this.name = 'EditorLostError'
    this.method = method
    this.sessionId = sessionId
    this.pendingMethods = pendingMethods
  }
}

export class BridgeTimeoutError extends Error {
  readonly method: string
  readonly timeoutMs: number
  /** The one thing the model must know: the editor may still be working. */
  readonly mayStillRun = true
  constructor(method: string, timeoutMs: number) {
    super(`"${method}" did not reply within ${timeoutMs}ms`)
    this.name = 'BridgeTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class NoEditorError extends Error {
  constructor(hint?: string) {
    super('no Unreal Editor is connected to this bridge')
    this.name = 'NoEditorError'
    if (hint) this.message += ` — ${hint}`
  }
}

/**
 * The head of the queue timed out and cannot be cancelled, so anything behind
 * it is queuing against an editor that may be busy for minutes. Refusing is the
 * honest alternative to a second timeout the caller cannot interpret.
 */
export class QueueStalledError extends Error {
  readonly stalledMethod: string
  constructor(stalledMethod: string) {
    super(
      `refusing to queue behind "${stalledMethod}", which has already timed out and cannot be cancelled in UE — check ual_status before sending more`,
    )
    this.name = 'QueueStalledError'
    this.stalledMethod = stalledMethod
  }
}

type BridgeEvent =
  | { type: 'editor-connected'; session: UalSession }
  | { type: 'editor-identified'; session: UalSession }
  | { type: 'editor-lost'; session: UalSession; reason: string }
  | { type: 'log'; entry: BridgeLogEntry }
  | { type: 'import'; method: string; payload: Record<string, unknown> }

/**
 * A correlated reply. Both halves are needed by the caller: several commands
 * answer `200` with a failed body, so the code alone is not success and the body
 * alone loses `207` partial-success.
 */
export interface BridgeReply {
  /** Verbatim plugin `code`. 200 success, 207 partial, anything else failure. */
  code: number
  /** Verbatim `result` — absent when the plugin sent no body. */
  result?: JsonValue
}

export class UalBridge {
  private readonly options: Required<Omit<BridgeOptions, 'logMinLevel'>> & { logMinLevel?: string }
  private server: WebSocketServer | undefined
  /** Keyed by the socket, because identity (`project.info`) arrives late. */
  private readonly sessions = new Map<WebSocket, UalSession>()
  private readonly sessionIds = new Map<string, WebSocket>()
  private readonly pending = new Map<string, PendingRequest>()
  /** Per-editor FIFO: the game thread is single-file. */
  private readonly queues = new Map<string, Promise<unknown>>()
  /**
   * Per-editor marker for a method whose reply we gave up on and UE cannot be
   * told to stop. Keyed by session id: one hung editor must not stall the queue
   * of a second, healthy one.
   */
  private readonly orphaned = new Map<string, string>()
  private readonly logs: BridgeLogEntry[] = []
  private readonly listeners = new Set<(event: BridgeEvent) => void>()
  private logSeq = 0
  private counters = { sent: 0, replies: 0, failures: 0, sendRejected: 0 }
  private stopped = false
  private noteSink: (message: string) => void = () => {}

  constructor(options: BridgeOptions = {}) {
    this.options = {
      host: options.host ?? '127.0.0.1',
      port: options.port ?? UAL_DEFAULT_PORT,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT,
      logCapacity: options.logCapacity ?? 512,
      lostBatchSize: options.lostBatchSize ?? 4,
      logMinLevel: options.logMinLevel,
    }
  }

  on(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(event: BridgeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // A diagnostic listener must never break the wire.
      }
    }
  }

  setNoteSink(sink: (message: string) => void): void {
    this.noteSink = sink
  }

  /**
   * Tracked by us rather than read off the server: `WebSocketServer` does not
   * expose `listening` in `@types/ws`, and `address()` throws before bind —
   * so a flag set only after a successful bind is the reliable answer.
   */
  private isListening = false

  get listening(): boolean {
    return this.isListening
  }

  get boundPort(): number {
    return this.options.port
  }

  /** Bind the listening socket. Fails loudly: an unbound bridge is a dead plugin. */
  async listen(): Promise<void> {
    if (this.stopped) throw new Error('this bridge was stopped; construct a new one')
    if (this.server) return
    const server = new WebSocketServer({ host: this.options.host, port: this.options.port, maxPayload: 64 * 1024 * 1024 })
    this.server = server
    // Attached before `listening` so a reconnecting editor that arrives during
    // bind is not dropped: UE retries every 5 s, and a missed attempt costs the
    // user another five seconds of "no editor connected".
    server.on('connection', (socket, request) => this.attach(socket, request))
    server.on('error', error => this.noteSink(`bridge server error: ${error.message}`))

    await new Promise<void>((resolve, reject) => {
      const done = () => {
        server.off('error', fail)
        this.isListening = true
        resolve()
      }
      const fail = (error: Error) => {
        server.off('listening', done)
        reject(error)
      }
      server.once('listening', done)
      server.once('error', fail)
    })
  }

  /**
   * Reject a peer that is not on the loopback the config asked for.
   *
   * UAL carries **no auth at all** — `CreateWebSocket(url)` with no headers,
   * subprotocol, or token — so the port *is* the credential: whatever reaches it
   * can run `cpp.compile` or `editor.quit` against the user's editor. Binding
   * anywhere but loopback therefore needs an explicit config, and even then a
   * non-local peer is refused unless the host was deliberately widened. This
   * bridge does not invent a trust model UE does not have.
   */
  private trusted(socket: WebSocket): boolean {
    const remote = (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket?.remoteAddress
    if (!remote) return true
    if (remote.startsWith('127.') || remote === '::1' || remote.startsWith('::ffff:127.')) return true
    return this.options.host !== '127.0.0.1' && this.options.host !== 'localhost'
  }

  private attach(socket: WebSocket, request: import('node:http').IncomingMessage): void {
    void request
    if (!this.trusted(socket)) {
      this.noteSink('refused a non-loopback WebSocket peer')
      socket.close(1008, 'dsh-unreal-agentlink accepts loopback editors only')
      return
    }

    const session: UalSession = {
      sessionId: `ue-${randomUUID().slice(0, 8)}`,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      heartbeats: 0,
    }
    this.sessions.set(socket, session)
    this.sessionIds.set(session.sessionId, socket)
    this.queues.set(session.sessionId, Promise.resolve())
    this.emit({ type: 'editor-connected', session })

    socket.on('message', (data: RawData) => this.receive(socket, data))
    socket.on('close', () => this.detach(socket, 'socket closed'))
    socket.on('error', () => this.detach(socket, 'socket error'))
  }

  private detach(socket: WebSocket, reason: string): void {
    const session = this.sessions.get(socket)
    this.sessions.delete(socket)
    if (!session) return
    this.sessionIds.delete(session.sessionId)
    this.queues.delete(session.sessionId)
    this.failPendingFor(session, reason)
    session.closed = true
    this.emit({ type: 'editor-lost', session, reason })
  }

  private failPendingFor(session: UalSession, reason: string): void {
    const mine = [...this.pending.values()].filter(entry => entry.sessionId === session.sessionId)
    if (mine.length === 0) return
    const methods = mine.map(entry => entry.method)
    for (const entry of mine) this.settleFailure(entry, new EditorLostError(entry.method, session.sessionId, methods))
    if (mine.length >= this.options.lostBatchSize) {
      // One lost batch is one fact, not N identical failures.
      this.noteSink(`lost ${mine.length} in-flight request(s) on ${session.sessionId}: ${reason}`)
    }
  }

  private receive(socket: WebSocket, data: RawData): void {
    const session = this.sessions.get(socket)
    if (!session) return
    session.lastSeenAt = Date.now()

    let message: UalMessage
    try {
      message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data as Buffer).toString('utf8')) as UalMessage
    } catch {
      return // UE drops a malformed frame the same way, with no reply.
    }
    if (!message || typeof message !== 'object') return

    if (message.type === 'res') return this.handleResponse(message as UalResponse)
    if (message.type === 'evt') return this.handleEvent(session, message as UalEvent)
    // The plugin is a client; it sends no `req`. Ignoring anything else mirrors
    // UE's own "Ignore non-request message", in both directions.
  }

  private handleResponse(response: UalResponse): void {
    const entry = this.pending.get(response.id)
    if (!entry) return // late reply for a request already given up on
    this.pending.delete(response.id)
    this.orphaned.delete(entry.sessionId)
    this.counters.replies += 1

    // 200 is success and 207 is PARTIAL success — the plugin answers 207 when a
    // batch landed for some targets and failed for others (`blueprint.set_property`,
    // `pcg.apply_graph`), and a computed code when nothing landed at all
    // (`actor.spawn` → 500, `material.apply` → 404). `code: 0` is never used.
    // Discarding a 207 body would throw away the list of which targets failed,
    // which is the one thing the caller needs.
    //
    // A 200 is still not always success: several handlers answer 200 with
    // `result.ok === false` (`editor.undo`, `blueprint.compile`, `pie.observe`), so
    // the code and the body are both handed up and `service.call` judges them.
    if (response.code === 200 || response.code === 207) {
      entry.resolve({ code: response.code, ...(response.result !== undefined ? { result: response.result } : {}) })
      return
    }

    const result = response.result
    const rawMessage = typeof result?.message === 'string' ? result.message : `UnrealAgentLink returned code ${response.code}`
    const details = typeof result?.details === 'object' && result.details !== null ? (result.details as Record<string, unknown>) : undefined
    this.counters.failures += 1
    this.settleFailure(
      entry,
      Object.assign(new Error(rawMessage), {
        name: 'UalCommandError',
        method: entry.method,
        code: response.code,
        details,
        result,
        elapsedMs: Date.now() - entry.startedAt,
      }),
    )
  }

  private handleEvent(session: UalSession, event: UalEvent): void {
    const payload = (event.payload ?? {}) as Record<string, unknown>
    // Resolve the name through the table rather than switching on the raw string:
    // a name that is not in `EVENT_HANDLING` is one this bridge does not know, and
    // the fall-through says so instead of looking like an oversight.
    const handling = Object.hasOwn(EVENT_HANDLING, event.method)
      ? EVENT_HANDLING[event.method as UalEventMethod]
      : undefined
    switch (handling) {
      case 'identify': {
        session.info = payload as ProjectInfoPayload
        this.emit({ type: 'editor-identified', session })
        return
      }
      case 'close': {
        // Arrives ~0.1 s before the close. Failing now means the last commands
        // learn "the editor quit" rather than "socket closed".
        this.failPendingFor(session, 'project.closed')
        session.closed = true
        this.emit({ type: 'editor-lost', session, reason: 'project.closed' })
        return
      }
      case 'heartbeat': {
        session.heartbeats += 1
        return
      }
      case 'log': {
        this.rememberLog(session, payload)
        return
      }
      case 'import': {
        this.emit({ type: 'import', method: event.method, payload })
        return
      }
      default:
        return // Unknown `evt` ignored, exactly as UE ignores inbound non-`req`.
    }
  }

  private rememberLog(session: UalSession, payload: Record<string, unknown>): void {
    const level = typeof payload.level === 'string' ? payload.level : 'Unknown'
    const min = this.options.logMinLevel
    if (min && (LEVEL_ORDER[level] ?? 7) > (LEVEL_ORDER[min] ?? 7)) return
    const entry: BridgeLogEntry = {
      seq: ++this.logSeq,
      at: Date.now(),
      session: session.sessionId,
      level,
      category: typeof payload.category === 'string' ? payload.category : 'Log',
      text: typeof payload.text === 'string' ? payload.text : '',
      // Spread, not `project: session.info?.projectName`. A forwarded log can
      // arrive before `project.info` (UE only starts forwarding once
      // `ual.ForwardLogs 1` is set, and a log can be emitted between the socket
      // opening and the handshake event), and an own property holding `undefined`
      // is not lossless JSON — `ual_logs` would throw ToolOutputError instead of
      // showing the log line that was actually captured.
      ...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {}),
    }
    this.logs.push(entry)
    if (this.logs.length > this.options.logCapacity) this.logs.splice(0, this.logs.length - this.options.logCapacity)
    this.emit({ type: 'log', entry })
  }

  /** Live editors, whether or not they have announced themselves yet. */
  get editors(): UalSession[] {
    return [...this.sessions.values()].filter(session => !session.closed)
  }

  /**
   * Which editor a request goes to. `target` matches the session id, the exact
   * project name, or a substring of the project name / `.uproject` path —
   * enough to disambiguate the multi-editor case UE's design explicitly allows.
   */
  resolve(target?: string): UalSession {
    const live = this.editors
    if (live.length === 0) {
      throw new NoEditorError('open the project in Unreal Editor; the plugin dials in by itself and retries every 5s')
    }
    if (!target) {
      if (live.length === 1) return live[0]!
      throw new NoEditorError(
        `${live.length} editors are connected (${live.map(session => session.info?.projectName ?? session.sessionId).join(', ')}); pass "editor" to pick one`,
      )
    }
    const exact = live.find(session => session.sessionId === target)
    if (exact) return exact
    const needle = target.toLowerCase()
    const named = live.filter(session => {
      const info = session.info
      if (typeof info?.projectName === 'string') {
        const name = info.projectName.toLowerCase()
        if (name === needle || name.includes(needle)) return true
      }
      return typeof info?.projectPath === 'string' && info.projectPath.toLowerCase().includes(needle)
    })
    if (named.length === 1) return named[0]!
    if (named.length > 1) throw new NoEditorError(`"${target}" matches ${named.length} editors; pass an exact session id`)
    throw new NoEditorError(`no connected editor matches "${target}"`)
  }

  /**
   * Send one request and await its reply, serialized per editor.
   * @throws SerializationError before touching the wire for a payload UE would
   * silently mis-read; NoEditorError; BridgeTimeoutError; EditorLostError;
   * QueueStalledError.
   */
  async send(options: SendOptions): Promise<BridgeReply> {
    if (this.stopped) throw new Error('the UnrealAgentLink bridge has been stopped')
    const session = this.resolve(options.editor)
    return this.sendTo(session, options)
  }

  /** As {@link send}, with the editor already chosen. */
  async sendTo(session: UalSession, options: SendOptions): Promise<BridgeReply> {
    if (this.stopped) throw new Error('the UnrealAgentLink bridge has been stopped')
    const socket = this.sessionIds.get(session.sessionId)
    if (!socket || session.closed) throw new NoEditorError(`editor ${session.sessionId} is gone`)

    // Validated before the wire: a payload UE would silently mis-read must not
    // become a successful-looking no-op.
    const params = options.params === undefined ? undefined : (toSerializable(options.params, options.method) as Record<string, unknown>)
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs

    const previous = this.queues.get(session.sessionId) ?? Promise.resolve()
    const run = async (): Promise<BridgeReply> => {
      if (this.stopped) throw new Error('the UnrealAgentLink bridge has been stopped')
      if (options.signal?.aborted) throw abortError(options.signal)
      if (this.orphaned.has(session.sessionId) && !options.long) {
        throw new QueueStalledError(this.orphaned.get(session.sessionId)!)
      }
      return this.dispatch(session, socket, options.method, params, timeoutMs, options.signal)
    }

    const chained = previous.then(run, run)
    // The queue must survive a rejection, or one failure wedges the editor.
    this.queues.set(session.sessionId, chained.catch(() => undefined))
    return chained
  }

  private dispatch(
    session: UalSession,
    socket: WebSocket,
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<BridgeReply> {
    const id = `dsh-${randomUUID()}`
    const payload = JSON.stringify({
      ver: UAL_VERSION,
      type: 'req' as const,
      method,
      id,
      ...(params === undefined ? {} : { params }),
    })

    return new Promise<BridgeReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return
        // We cannot tell UE to stop. Recording the orphan against THIS editor is
        // the only honest move left: another connected editor is not stalled, and
        // a per-socket orphan would let one hung editor block the others.
        this.orphaned.set(session.sessionId, method)
        this.counters.failures += 1
        cleanup()
        reject(new BridgeTimeoutError(method, timeoutMs))
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      const onAbort = () => {
        if (!this.pending.delete(id)) return
        // Same reasoning as the timeout above: aborting our wait does not stop
        // UE. A killed ual_task leaves the editor busy, so the method is recorded
        // as orphaned and the next short call refuses rather than queueing behind
        // work that may never answer.
        this.orphaned.set(session.sessionId, method)
        this.counters.failures += 1
        cleanup()
        reject(abortError(signal))
      }

      const entry: PendingRequest = {
        id,
        method,
        sessionId: session.sessionId,
        startedAt: Date.now(),
        timer,
        resolve: value => {
          cleanup()
          resolve({ code: value.code, ...(value.result !== undefined ? { result: value.result as JsonValue } : {}) })
        },
        reject: error => {
          cleanup()
          reject(error)
        },
      }

      this.pending.set(id, entry)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.counters.sent += 1

      try {
        socket.send(payload, error => {
          if (!error || !this.pending.delete(id)) return
          // `message too long` would otherwise be lost silently: UE ignores the
          // return value of Socket->Send, so our send is the only place a
          // rejection can still become a real error.
          this.counters.sendRejected += 1
          this.counters.failures += 1
          entry.reject(new Error(`could not send "${method}" (${payload.length} bytes): ${error.message}`))
        })
      } catch (error) {
        if (!this.pending.delete(id)) return
        this.counters.failures += 1
        entry.reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  settleFailure(entry: PendingRequest, error: Error): void {
    entry.reject(error)
  }

  /** The retained log ring, oldest first. */
  get ringLogs(): readonly BridgeLogEntry[] {
    return this.logs
  }

  /** Editors silent longer than the liveness window — a hung editor still holds the queue. */
  staleEditors(): UalSession[] {
    const now = Date.now()
    return this.editors.filter(session => now - session.lastSeenAt > HEARTBEAT_STALE_MS)
  }

  stats(): BridgeStats {
    const now = Date.now()
    return {
      listening: this.listening,
      host: this.options.host,
      port: this.options.port,
      editors: this.editors.map(session => ({
        sessionId: session.sessionId,
        // Every optional field is spread in conditionally rather than written as
        // `undefined`. A socket connects a moment before it identifies itself, so
        // `info` is genuinely absent on the first `ual_status` after an editor
        // appears — and a value holding an `undefined` property is not lossless
        // JSON, so the tool registry rejects the whole result with ToolOutputError
        // instead of reporting "one editor, not yet identified".
        ...(session.info?.projectName !== undefined ? { project: session.info.projectName } : {}),
        ...(session.info?.projectPath !== undefined ? { projectPath: session.info.projectPath } : {}),
        ...(session.info?.engineVersion !== undefined ? { engineVersion: session.info.engineVersion } : {}),
        ...(session.info?.pluginBuild !== undefined ? { pluginBuild: session.info.pluginBuild } : {}),
        ...(session.info?.currentLevelName !== undefined ? { level: session.info.currentLevelName } : {}),
        ...(session.info?.runMode !== undefined ? { runMode: session.info.runMode } : {}),
        connectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
        heartbeats: session.heartbeats,
        stale: now - session.lastSeenAt > HEARTBEAT_STALE_MS,
      })),
      pending: this.pending.size,
      pendingMethods: [...this.pending.values()].map(entry => entry.method),
      orphanedMethods: [...this.orphaned.values()],
      logsRetained: this.logs.length,
      ...this.counters,
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const entry of [...this.pending.values()]) {
      this.pending.delete(entry.id)
      entry.reject(new Error('the UnrealAgentLink bridge is shutting down'))
    }
    this.orphaned.clear()
    this.isListening = false
    for (const socket of this.sessions.keys()) {
      try {
        socket.terminate()
      } catch {
        // Already gone.
      }
    }
    this.sessions.clear()
    this.sessionIds.clear()
    this.queues.clear()
    this.listeners.clear()

    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      // No `closeAllChunks` in `@types/ws`: sweep the live sockets ourselves.
      // Sockets were already terminated above, so this only stops a late
      // reconnect from keeping the handle open.
      for (const socket of server.clients) {
        try {
          socket.close(1001, 'dsh plugin unloaded')
        } catch {
          // Already gone.
        }
      }
      server.close(finish)
      // `close()` waits for every socket to end; an unload must not block on a
      // half-dead editor, so the fallback timer wins after a short grace.
      setTimeout(finish, 500).unref?.()
    })
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  const error = new Error(reason instanceof Error ? reason.message : 'the tool call was cancelled')
  error.name = 'AbortError'
  return error
}
