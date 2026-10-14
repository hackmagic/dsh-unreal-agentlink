import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * The UnrealAgentLink (UEBox) wire vocabulary, transcribed from the upstream
 * plugin source `ueboxai/uebox@main` → `plugin/UnrealAgentLink` (v1.2.14,
 * engines 5.0–5.8) so every key name here is verbatim, not remembered.
 *
 * ## The one thing to know before reading this file
 *
 * The plugin is **not an HTTP server**. `StartupModule()` dials OUT:
 *
 * ```cpp
 * FString DefaultUrl = TEXT("ws://127.0.0.1:17860");
 * FParse::Value(FCommandLine::Get(), TEXT("UALServer="), OverrideUrl)
 * FUAL_NetworkManager::Get().Init(DefaultUrl);
 * ```
 *
 * Unreal Engine is the WebSocket **client**. So this bridge is the **server**,
 * listening on 17860 and waiting for editors to arrive. A README that says
 * "start the HTTP service" describes a protocol that does not exist; see
 * `docs` in the package README for the correction and its evidence.
 *
 * There is also no auth: `CreateWebSocket(url)` with no headers, subprotocol,
 * or token. Whatever connects to the port is a trusted local editor, which is
 * why {@link BridgeConfig.host} defaults to loopback and why the token field
 * from the original draft is gone.
 *
 * @module protocol/types
 */

/** Envelope `ver` the plugin writes on every message. It never reads it back. */
export const UAL_VERSION = '1.0'

/**
 * A parsed JSON object.
 *
 * Every `result`/`params`/`payload` body on this wire is one by construction
 * (`JSON.parse` output), and typing it as `JsonObject` rather than
 * `Record<string, unknown>` is what lets a tool return it as a canonical
 * `JsonValue` without a cast — the tool registry validates canonical values, so
 * an `unknown` here becomes a type error at best and a silent lie at worst.
 *
 * Defined here rather than imported because `@deepseek-ai/dsh-util-values`
 * exports `JsonValue` but not the object alias.
 */
export type JsonObject = { [key: string]: JsonValue }

/** Default dial-in port, from `ws://127.0.0.1:17860` in `StartupModule()`. */
export const UAL_DEFAULT_PORT = 17860

/**
 * Codes the plugin really sends, harvested from every `SendError`/`SendResponse`
 * call site in the vendored C++ (`200, 207, 400, 404, 409, 410, 412, 413, 422,
 * 500, 501, 503, 504`).
 *
 * Deliberately NOT a type alias applied to `UalResponse.code`: the code arrives
 * as untyped JSON, so narrowing there would only buy a cast at the boundary
 * while making a future UE-side addition a compile error in this repo. Kept as
 * data so `translate()` can be read against the real set.
 */
export const UAL_CODES = [200, 207, 400, 404, 409, 410, 412, 413, 422, 500, 501, 503, 504] as const

/**
 * Outbound request. `params` is canonical (`payload` is accepted by the plugin
 * as a legacy alias, and we send the canonical one). `id` is minted here — the
 * plugin never invents one, and `SendResponse` bails on an empty id, so an
 * omitted id means a silently never-arriving reply.
 */
export interface UalRequest {
  ver: string
  type: 'req'
  method: string
  id: string
  params?: Record<string, unknown>
  // (Outbound params are pre-serialization: `toSerializable` converts them and
  // rejects non-finite values, so `unknown` here is the honest type.)
}

/**
 * Inbound reply. Failure is signalled by `code` alone: there is no top-level
 * `error` and no envelope-level `ok`. `result` is absent when the plugin had
 * nothing to send, and on an error it carries `{message, details?}`.
 */
export interface UalResponse {
  ver?: string
  type: 'res'
  id: string
  method?: string
  code: number
  result?: JsonObject
}

/**
 * Inbound push. Never carries `id`; carries `payload` (possibly `{}`).
 *
 * `method` stays `string`: it is read from untrusted JSON, so narrowing it here
 * would be a lie about the wire. The known vocabulary lives in `UalEventMethod`
 * below, and `bridge.ts` checks an incoming name against it before dispatching.
 */
export interface UalEvent {
  ver?: string
  type: 'evt'
  method: string
  payload?: JsonObject
}

export type UalMessage = UalRequest | UalResponse | UalEvent

/**
 * `evt` method names this bridge knows how to read.
 *
 * This union is the authority, not a comment: `bridge.ts` declares a
 * `satisfies Record<UalEventMethod, true>` table for the events it handles, so
 * adding an arm here fails the build until the bridge acknowledges it, and
 * removing one makes its handling unreachable.
 */
export type UalEventMethod =
  /** Pushed on every `OnConnected`; camelCase payload — the handshake substitute. */
  | 'project.info'
  /** Pushed from `ShutdownModule()`, ~0.1s before the socket closes. */
  | 'project.closed'
  /** 10s liveness ticker while connected; empty payload. */
  | 'system.heartbeat'
  /** Every UE log line — only when the in-editor cvar `ual.ForwardLogs` is 1. */
  | 'log.entry'
  /** Content Browser "import to UEBox library" menu actions. */
  | 'content.import_folder'
  | 'content.import_assets'

/** The subset of `project.info` this bridge keys on. All camelCase. */
export interface ProjectInfoPayload {
  projectName?: string
  projectPath?: string
  engineVersion?: string
  pluginBuild?: string
  runMode?: string
  interactive?: boolean
  currentLevelName?: string
  currentLevelPath?: string
  pythonAvailable?: boolean
  [key: string]: unknown
}

/**
 * A connected editor. `info` arrives from the `project.info` event, so a
 * socket that has not announced itself yet is a session with `info === undefined`
 * — commands may already run on it, we just do not know which project yet.
 */
export interface UalSession {
  readonly sessionId: string
  info?: ProjectInfoPayload
  connectedAt: number
  lastSeenAt: number
  heartbeats: number
  /** Monotonic id for `project.closed` bookkeeping. */
  closed?: boolean
}

/** One in-flight request the bridge is waiting to correlate. */
export interface PendingRequest {
  id: string
  method: string
  /** Which editor owns it, so a disconnect fails only that editor's batch. */
  sessionId: string
  /**
   * Settled with the reply's `code` alongside its body: `207` is partial success
   * and several commands answer `200` with `result.ok === false`, so the caller
   * needs both to judge the outcome.
   */
  resolve: (reply: { code: number; result?: Record<string, unknown> }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  startedAt: number
}

/** A bridge-local failure (no editor connected, breaker open, rate limited). */
export type LocalFailure =
  | 'no-editor'
  | 'circuit-open'
  | 'rate-limited'
  | 'timeout'
  | 'aborted'
  | 'not-serializable'
  | 'stopped'

export class UalError extends Error {
  readonly method: string
  readonly code: number | undefined
  readonly details: Record<string, unknown> | undefined
  readonly elapsedMs: number | undefined
  readonly local: LocalFailure | undefined
  readonly lost: boolean

  constructor(init: {
    method: string
    message: string
    code?: number
    details?: Record<string, unknown>
    elapsedMs?: number
    local?: LocalFailure
    lost?: boolean
    cause?: unknown
  }) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause })
    this.name = 'UalError'
    this.method = init.method
    this.code = init.code
    this.details = init.details
    this.elapsedMs = init.elapsedMs
    this.local = init.local
    this.lost = init.lost === true
  }
}
