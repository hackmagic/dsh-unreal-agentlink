/**
 * Shared plumbing for the model-facing tools.
 *
 * Two things every tool here needs and should not each re-derive:
 *
 * 1. **The session key.** DSH's per-session isolation is keyed by the calling
 *    agent's session id, which is what makes the ledger, the read cache, and the
 *    lock claims belong to *this* conversation rather than to the process. When
 *    there is no agent (a programmatic or nested dispatch), everything falls into
 *    one shared bucket — reported as such rather than silently pretending to be
 *    isolated.
 * 2. **A bounded model-facing render.** UAL answers can be large: `actor.get` with
 *    a filter over a big level, `blueprint.get_graph` on a 900-node graph,
 *    `content.search` across a project. The canonical value keeps everything (so
 *    PTC and a UI card see the truth), while the content the model reads is
 *    truncated with an explicit marker. A silently-truncated tool result is how an
 *    agent concludes "there are 50 lights" about a 300-light level, so the marker
 *    is the point.
 *
 * @module tools/util
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { CallValue } from '../service.js'

/** The shared `ual_call`-shaped output contract. */
export const CALL_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean', required: true },
    method: { type: 'string', required: true },
    /** Verbatim `result` from UnrealAgentLink — never reshaped. */
    result: { type: 'json' },
    code: { type: 'integer' },
    error: { type: 'string' },
    hint: { type: 'string' },
    kind: { type: 'string' },
    details: { type: 'json' },
    cached: { type: 'boolean' },
    mayStillRun: { type: 'boolean' },
    elapsedMs: { type: 'integer' },
  },
} as const

export const CALL_RENDER = (_args: unknown, value: JsonValue): ContentBlock[] => [
  { type: 'text', text: renderCall(value as unknown as CallValue) },
]

/**
 * Drop `undefined`-valued keys so a value is a real `JsonValue`.
 *
 * The tool registry's output contract is canonical JSON, where `undefined` does
 * not exist — and a key explicitly set to `undefined` fails the index signature
 * even though `JSON.stringify` would silently drop it. TypeScript surfaces that
 * as a confusing "Two different types" on the whole `execute`, so the fix belongs
 * at the boundary rather than in every call site.
 */
export function jsonable<T extends object>(value: T): JsonValue {
  const out: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item as JsonValue
  }
  return out
}

/**
 * Render one call value.
 *
 * On failure the hint and details come first: a model that reads `error` and
 * retries is exactly the loop the hint exists to break.
 */
export function renderCall(value: CallValue): string {
  if (!value.ok) {
    const lines = [`FAILED ${value.method}: ${value.error ?? 'unknown error'}`]
    if (value.kind) lines.push(`  kind: ${value.kind}${value.code !== undefined ? ` (ue code ${value.code})` : ''}`)
    if (value.hint) lines.push(`  do this: ${value.hint}`)
    if (value.details !== undefined) lines.push(`  details: ${clip(stringify(value.details), 1_500)}`)
    if (value.mayStillRun) lines.push('  WARNING: the editor may still be running this command; verify before retrying.')
    return lines.join('\n')
  }
  const head = `OK ${value.method}${value.cached ? ' (cached)' : ''}`
  const body = value.result === undefined ? '(no result body)' : clip(stringify(value.result), MAX_MODEL_CHARS)
  return `${head}\n${body}`
}

/**
 * The character budget for one tool result's model-facing content.
 *
 * Deliberately a *content* bound, not a canonical-value bound: `output.render`
 * owns what the model reads, while `value` stays complete for PTC callers and the
 * UI card. See `docs/cookbook/adding-a-tool.md`.
 */
export const MAX_MODEL_CHARS = 24_000

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars — the full value is kept in the tool result, narrow the query or raise limit]`
}

export function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 1) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Compact one-line JSON, for titles and summaries. */
export function brief(value: unknown, max = 160): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** The DSH session id a call belongs to, plus whether it is a real one. */
export function sessionOf(exec: ToolRunContext): { session: string; isolated: boolean } {
  const agent: Agent | undefined = exec.agent
  if (agent?.id !== undefined && agent.id !== null) return { session: String(agent.id), isolated: true }
  return { session: 'unscoped', isolated: false }
}

/** The `{x,y,z}` shape UAL uses for `location`, `min`, `max` and friends. */
export const VEC_SPEC = {
  type: 'object',
  additionalProperties: true,
  properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } },
} as const

/** Media type from a filename, or undefined when it is not a raster we can attach. */
export function mediaTypeOf(path: string): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}
