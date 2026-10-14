/**
 * Turning a UE failure into something an agent can act on.
 *
 * ## Why the raw message is not enough
 *
 * The plugin's error text is built by `UAL_CommandUtils::LStr(Zh, En)`, keyed off
 * the editor's *culture* — so the same failure arrives in Chinese on a Chinese
 * editor and in English on an English one, and a few strings are Chinese-only with
 * no English twin at all (the screenshot timeout is one). Anything keyed on that
 * text breaks per-locale. So `code` and `result.details` carry the meaning here,
 * and the message is passed through as evidence, never parsed for control flow.
 *
 * What actually carries machine-readable facts is `details`: `suggestions` and
 * `expected_type`/`current_value` from `actor.set_property`, the registry progress
 * blob from a 503, `blocked_by_agent_undo` from `content.delete`, the failed/unmatched
 * arrays the batch commands report. A 500 with `details.suggestions` is a one-token
 * fix; the same 500 with only its message is a guess. The translator's job is to
 * surface the former loudly and to stop the latter from being retried blindly.
 *
 * @module errors/translate
 */

import type { JsonObject } from '../protocol/types.js'
import { riskOf, BLACKLIST, isKnown, requiresOf } from '../catalog/methods.js'
import { REGISTRY_STATUS_KEYS } from '../catalog/method-overrides.js'

export interface TranslatedError {
  /** One line, for the model. */
  error: string
  /** What to do next. Never "check the logs". */
  hint: string
  /** Machine-stable code we own, so behaviour can branch on it across locales. */
  kind: ErrorKind
  /** The plugin's own code, when the failure came from the wire. */
  ueCode?: number
  /** Facts worth re-showing (suggestions, expected_type, progress). */
  facts?: JsonObject
  /** Whether retrying the exact same call could ever help. */
  retryable: boolean
}

export type ErrorKind =
  | 'no-editor'
  | 'timeout'
  | 'editor-lost'
  | 'circuit-open'
  | 'rate-limited'
  | 'queue-stalled'
  | 'serialization'
  | 'unknown-method'
  | 'bad-params'
  | 'not-found'
  | 'conflict'
  | 'precondition'
  | 'registry-busy'
  | 'unsupported'
  | 'engine-error'
  | 'cancelled'

/** `UAL` codes that mean "the editor is unhealthy" rather than "you asked wrong". */
const TRANSPORT_CODES = new Set<number>([500, 501, 503])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * The bridge/transport error classes are structural, so they are detected by
 * name rather than by importing them: the tools package and the bridge package
 * must not need each other's types to render a failure.
 */
function classify(error: unknown): { kind: ErrorKind; message: string; details?: JsonObject } {
  const name = (error as { name?: string })?.name ?? ''
  const message = error instanceof Error ? error.message : String(error)
  const details = isRecord((error as { details?: unknown })?.details) ? (error as { details: JsonObject }).details : undefined

  switch (name) {
    case 'NoEditorError':
      return { kind: 'no-editor', message, details }
    case 'BridgeTimeoutError':
      return { kind: 'timeout', message, details }
    case 'EditorLostError':
      return { kind: 'editor-lost', message, details }
    case 'CircuitOpenError':
      return { kind: 'circuit-open', message, details }
    case 'RateLimitedError':
      return { kind: 'rate-limited', message, details }
    case 'QueueStalledError':
      return { kind: 'queue-stalled', message, details }
    case 'SerializationError':
      return { kind: 'serialization', message, details }
    case 'AbortError':
      return { kind: 'cancelled', message, details }
    default:
      break
  }

  const code = (error as { code?: number })?.code
  if (typeof code === 'number') {
    if (code === 404) return { kind: 'not-found', message, details }
    if (code === 400) return { kind: 'bad-params', message, details }
    if (code === 409) return { kind: 'conflict', message, details }
    // 410: the thing the command was working on vanished mid-flight (PCG volume
    // destroyed while generating). Same actionable shape as a 404 — the name is
    // stale — so it shares the kind rather than inventing one.
    if (code === 410) return { kind: 'not-found', message, details }
    if (code === 412 || code === 413) return { kind: 'precondition', message, details }
    // 422: understood but not processable (blueprint.import_t3d accepted the text
    // and imported zero nodes, then rolled its transaction back). Falling through
    // to `engine-error` told the model the opposite of the truth — that the
    // arguments were fine and the editor broke.
    if (code === 422) return { kind: 'precondition', message, details }
    if (code === 501) return { kind: 'unsupported', message, details }
    if (code === 503) return { kind: 'registry-busy', message, details }
    // 504: the editor waited out its own budget (PCG's previous result never
    // cleared). That is a timeout, and it needs the timeout advice — the work may
    // still be running.
    if (code === 504) return { kind: 'timeout', message, details }
    if (TRANSPORT_CODES.has(code)) return { kind: 'engine-error', message, details }
  }
  return { kind: 'engine-error', message, details }
}

/** A 503 whose details look like the registry status blob is a scan, not a crash. */
function looksLikeRegistry(details: Record<string, unknown> | undefined): boolean {
  if (!details) return false
  return REGISTRY_STATUS_KEYS.some(key => key in details)
}

/**
 * @param error - anything the bridge or the wire produced.
 * @param method - the UAL method that failed, for the risk-aware advice.
 * @param editorHint - how to re-bind, when a bind is what is missing.
 */
export function translate(error: unknown, method: string, editorHint?: string): TranslatedError {
  const { kind, message, details } = classify(error)
  const raw = message
  const ueCode = (error as { code?: number })?.code
  const facts = details && Object.keys(details).length > 0 ? details : undefined

  switch (kind) {
    case 'no-editor':
      return {
        kind,
        error: raw,
        hint:
          editorHint ??
          'Open the project in Unreal Editor. The UnrealAgentLink plugin dials in to 127.0.0.1:17860 by itself and retries every 5 s, so there is nothing to "start" on this side — check 设置 → 插件 → 连接状态 in UEBox, and that this port is not already taken by the UEBox app.',
        retryable: true,
      }

    case 'timeout':
      return {
        kind,
        error: raw,
        // A 504 is the editor timing out on its own budget (PCG's previous
        // generation result never cleared), not our socket giving up — the
        // command already returned, so "still running" would be a lie here.
        hint:
          ueCode === 504
            ? `The editor gave up waiting on its own timeout, so "${method}" did not complete. Its message says what it was waiting for — usually a previous run that never cleared. Verify state with a read command, then retry with a longer timeout parameter if the method has one.`
            : `The editor is almost certainly still running "${method}" on its game thread — it executes commands synchronously and there is no cancel in UnrealAgentLink. Do NOT resend: verify the outcome with a read command (actor.get / editor.get_dirty / content.registry_status), and send long work through ual_task next time.`,
        retryable: false,
        facts,
        ueCode,
      }

    case 'editor-lost':
      return {
        kind,
        error: raw,
        hint: 'The editor closed or crashed while the command was running. Reopen the project and let the plugin reconnect, then re-check state with a read command before repeating anything — the write may have landed before it died.',
        retryable: false,
        facts,
      }

    case 'circuit-open':
      return {
        kind,
        error: raw,
        hint: 'Stop sending editor commands. Wait for the retry window shown, then call ual_status; if the editor is genuinely stuck, the user has to intervene in Unreal Editor itself.',
        retryable: true,
        facts,
      }

    case 'rate-limited':
      return {
        kind,
        error: raw,
        hint: 'Send fewer commands per turn, or batch them with ual_batch instead of issuing one tool call each.',
        retryable: true,
      }

    case 'queue-stalled':
      return {
        kind,
        error: raw,
        hint: 'A previous command that timed out cannot be cancelled and still owns the editor. Ask the user to check the editor window; do not keep queueing work behind it.',
        retryable: false,
      }

    case 'serialization':
      return {
        kind,
        error: raw,
        hint: `Fix the params before sending. UnrealAgentLink reads JSON with TryGet*Field accessors, which ignore an unknown or wrongly-typed key silently — the request would have returned ok and changed nothing. Use ual_schema { method: "${method}" } for the exact key names and types.`,
        retryable: false,
      }

    case 'unknown-method':
    case 'not-found': {
      // Own-property lookup: `BLACKLIST` is an object literal, so a bare index
      // would return `Object.prototype.toString` for a method named "toString"
      // and report a function as the replacement hint.
      const blocked = Object.hasOwn(BLACKLIST, method) ? BLACKLIST[method] : undefined
      if (blocked) return { kind, error: raw, hint: blocked, retryable: false, ueCode }
      // A 404 on a *registered* method means the object it named was not found,
      // which is different from the method not existing. `in` would also match
      // Object.prototype, so ask the catalog's own predicate.
      const registered = isKnown(method)
      if (ueCode === 410) {
        return {
          kind,
          error: raw,
          hint: `The object "${method}" was working on was destroyed before the command finished. Re-read the state (it is gone), then decide whether to recreate it — do not simply resend.`,
          retryable: false,
          ueCode,
          facts,
        }
      }
      return {
        kind,
        error: raw,
        hint: registered
          ? `"${method}" exists but whatever it names was not found. Check the path/name with a read command (actor.get, content.search, blueprint.list_graphs) before retrying.`
          : `UnrealAgentLink does not implement "${method}". ual_tools lists what this build does; if you meant a synonym, ${Object.keys(BLACKLIST).includes(method) ? 'see the note above' : 'the naming is dot-namespaced like actor.set_transform'}.`,
        retryable: false,
        ueCode,
        facts,
      }
    }

    case 'bad-params': {
      const suggestions = strings(details?.suggestions)
      const expected = details?.expected_type
      const current = details?.current_value
      if (suggestions.length > 0) {
        return {
          kind,
          error: raw,
          hint: `The plugin suggests: ${suggestions.join(', ')}. These are edit-distance matches against what you sent, so pick one rather than re-guessing.`,
          retryable: false,
          ueCode,
          facts,
        }
      }
      if (expected !== undefined) {
        return {
          kind,
          error: raw,
          hint: `Expected ${JSON.stringify(expected)} but sent ${JSON.stringify(current)}. ual_schema { method: "${method}" } gives the full shape.`,
          retryable: false,
          ueCode,
          facts,
        }
      }
      return {
        kind,
        error: raw,
        hint: `Read the message — it names the missing or invalid field. Required keys for "${method}": ${paramHint(method)}.`,
        retryable: false,
        ueCode,
        facts,
      }
    }

    case 'conflict': {
      if (details && 'blocked_by_agent_undo' in details) {
        return {
          kind,
          error: raw,
          hint: 'The agent undo buffer still holds a reference to this asset, so the engine refuses to delete it. Either ual_undo the steps that touched it, or re-send with drop_agent_undo:true — which discards those undo steps permanently, so say so to the user.',
          retryable: false,
          ueCode,
          facts,
        }
      }
      if (details && 'running' in details) {
        return { kind, error: raw, hint: 'PIE is already running. pie.stop first, or read pie.observe to see what is live.', retryable: false, ueCode, facts }
      }
      return {
        kind,
        error: raw,
        hint: 'The target already exists or is in a state this command refuses to change. Read the current state instead of forcing it.',
        retryable: false,
        ueCode,
        facts,
      }
    }

    case 'precondition': {
      if (details && typeof details.instances === 'number') {
        return {
          kind,
          error: raw,
          hint: `The batch is larger than ual.MaxBatchCreate allows (${details.max}). Split it into chunks of ${details.max} with ual_batch or successive calls.`,
          retryable: false,
          ueCode,
          facts,
        }
      }
      // 422: the engine accepted the payload but produced nothing (blueprint
      // import wrote zero nodes and rolled the transaction back). Nothing landed,
      // so the fix is in the input, not a retry.
      if (ueCode === 422) {
        return {
          kind,
          error: raw,
          hint: `The editor understood "${method}" but nothing was written, and it rolled its transaction back — so there is no partial state to clean up. The payload is wrong for this target: check the text/nodes you sent with a read command (blueprint.get_graph) and fix the input rather than resending it.`,
          retryable: false,
          ueCode,
          facts,
        }
      }
      return { kind, error: raw, hint: 'The precondition named in the message is not met; satisfy it or choose another method.', retryable: false, ueCode, facts }
    }

    case 'registry-busy': {
      if (!looksLikeRegistry(details)) {
        return { kind, error: raw, hint: 'The editor refused on capacity. Wait and retry once, then report to the user.', retryable: true, ueCode, facts }
      }
      const progress = isRecord(details?.progress) ? details.progress : undefined
      const done = typeof progress?.processed === 'number' ? progress.processed : undefined
      const total = typeof progress?.total === 'number' ? progress.total : undefined
      return {
        kind,
        error: raw,
        hint: `The asset registry is still scanning${done !== undefined && total !== undefined ? ` (${done}/${total})` : ''}. Poll content.registry_status via ual_call, or just retry after a few seconds. Do NOT pass on_registry_busy:"wait" — it blocks the game thread and deadlocks the scan that would release it.`,
        retryable: true,
        ueCode,
        facts,
      }
    }

    case 'unsupported':
      return {
        kind,
        error: raw,
        hint: `This editor build does not support "${method}" (501). system.get_project_info reports the capability flags — treat an absent flag as unsupported.`,
        retryable: false,
        ueCode,
        facts,
      }

    case 'cancelled':
      return {
        kind,
        error: raw,
        hint: 'The call was cancelled from the DSH side. The editor may still be running it; it cannot be cancelled in UnrealAgentLink.',
        retryable: false,
      }

    case 'engine-error':
    default: {
      const dangerous = riskOf(method) === 'dangerous'
      return {
        kind: 'engine-error',
        error: raw,
        hint: dangerous
          ? `"${method}" is a high-risk operation and failed inside the editor. Do not retry it blindly — read the message, and check state with a read command.`
          : 'This failed inside the editor rather than in the arguments. Read the message; if it names a property or path, verify it with a read command before retrying. Enable ual.ForwardLogs=1 in the editor and use ual_logs if the message is not enough.',
        retryable: false,
        ueCode,
        facts,
      }
    }
  }
}

/** Required-key hint from the derived table, when the handler named no key. */
function paramHint(method: string): string {
  const required = requiresOf(method)
  if (required.length > 0) return required.join(', ')
  return '(see ual_schema)'
}

/** Render one translated error as model-facing content blocks. */
export function renderError(translated: TranslatedError): { text: string; code?: number } {
  const parts = [`ERROR [${translated.kind}] ${translated.error}`]
  if (translated.ueCode !== undefined) parts.push(`ue_code=${translated.ueCode}`)
  parts.push(`HINT: ${translated.hint}`)
  if (translated.retryable) parts.push('RETRY: the same call may succeed later.')
  if (translated.facts) parts.push(`DETAILS: ${JSON.stringify(translated.facts)}`)
  return { text: parts.join('\n'), code: translated.ueCode }
}
