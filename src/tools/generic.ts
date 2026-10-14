/**
 * The generic bridge tools: the discovery pair and the two call paths.
 *
 * These five are why 170 editor capabilities cost the prompt about 2k tokens
 * instead of 170 tool schemas. The model discovers with `ual_tools`, reads exact
 * key names with `ual_schema`, and executes with `ual_call` / `ual_batch`.
 *
 * ## Why `ual_call` returns the plugin's body verbatim
 *
 * UAL's own docs, its Chinese markdown, and its handlers disagree in places (the
 * screenshot base64 claim being the clearest). Reshaping its answers into "nicer"
 * DTOs would bake our reading of the protocol into every result and make a
 * protocol change invisible. So `result` is what the editor said, untouched, and
 * anything this bridge adds (`hint`, `kind`, `cached`, `mayStillRun`) sits beside
 * it under names that cannot collide.
 *
 * ## Why the risk gate lives here and not inside each tool
 *
 * `ual_call` is one tool whose *arguments* decide the danger, so a per-tool policy
 * cannot see it. The gate is a `tools/pre-execute` listener keyed on the method
 * argument, registered by `index.ts`; it asks DSH's approval seam for destructive
 * and dangerous methods rather than inventing its own confirmation UI.
 *
 * @module tools/generic
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import type { UalService } from '../service.js'
import { BLACKLIST, METHOD_NAMES, METHODS, riskOf, specOf, paramKeysOf, codesOf, requiresOf } from '../catalog/methods.js'
import { RESULT_KEYS } from '../catalog/method-data.js'
import { EXTRA_RESULT_KEYS, NESTED_SHAPES } from '../catalog/method-overrides.js'
import { CALL_OUTPUT, CALL_RENDER, sessionOf, brief, clip, jsonable } from './util.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonObject } from '../protocol/types.js'

export function makeGenericTools(service: UalService): ToolDefinition[] {
  const ual_tools = defineTool({
    name: 'ual_tools',
    description:
      'List the UnrealAgentLink (Unreal Editor) commands this bridge can run, filtered by a substring of the method name or its summary. Returns method, risk, and a one-line summary. Use ual_schema for the exact parameter keys of one command. Start here when you know what you want to do but not which command does it.',
    parameters: {
      filter: { type: 'string', description: 'substring over method names and summaries, e.g. "material", "blueprint.", "screenshot"' },
      risk: { type: 'string', enum: ['read', 'write', 'destructive', 'dangerous'], description: 'keep only commands at this risk level or lower' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          returned: { type: 'integer', required: true },
          methods: { type: 'array', items: { type: 'json' }, required: true },
          refused: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        const record = value as { total: number; returned: number; methods: unknown[]; refused?: { method: string; why: string }[] }
        const lines = [`${record.returned} of ${record.total} UnrealAgentLink commands:`]
        for (const entry of record.methods) lines.push(`  ${brief(entry, 300)}`)
        if (record.refused?.length) {
          lines.push('Known names that do NOT work here:')
          for (const entry of record.refused) lines.push(`  ${entry.method}: ${entry.why}`)
        }
        return [{ type: 'text', text: clip(lines.join('\n'), 24_000) }]
      },
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const riskOrder = ['read', 'write', 'destructive', 'dangerous'] as const
      const max = args.risk ? riskOrder.indexOf(args.risk) : 3
      const all = service.toolList(args.filter)
      const kept = all.filter(entry => riskOrder.indexOf(entry.risk) <= max)
      // Surfacing the dead names in the same place the model is looking prevents
      // the specific loop where it re-discovers `editor.play`, tries it, gets a
      // 404, and concludes the plugin is broken.
      const needle = args.filter?.toLowerCase()
      const refused = Object.entries(BLACKLIST)
        .filter(([method]) => !needle || method.toLowerCase().includes(needle))
        .map(([method, why]) => ({ method, why }))
      return { total: METHOD_NAMES.length, returned: kept.length, methods: kept, refused }
    },
  })

  const ual_schema = defineTool({
    name: 'ual_schema',
    description:
      'The exact parameter keys, result keys, and answer codes UnrealAgentLink uses for one command — extracted from the plugin source, so the names are verbatim. Call this before ual_call on any command you have not used before: UE reads unknown or wrongly-typed keys silently and answers ok without changing anything.',
    parameters: {
      method: { type: 'string', required: true, description: 'one method name from ual_tools, e.g. "actor.set_transform"' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          method: { type: 'string', required: true },
          risk: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          requires: { type: 'array', items: { type: 'string' } },
          params: { type: 'array', items: { type: 'string' }, required: true },
          resultKeys: { type: 'array', items: { type: 'string' }, required: true },
          codes: { type: 'array', items: { type: 'integer' }, required: true },
          blocking: { type: 'boolean' },
          warning: { type: 'string' },
          nested: { type: 'array', items: { type: 'json' } },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as {
          ok: boolean
          method: string
          risk?: string
          summary?: string
          requires?: string[]
          params?: string[]
          resultKeys?: string[]
          codes?: number[]
          blocking?: boolean
          warning?: string
          nested?: { name: string; keys: string[] }[]
          hint?: string
        }
        if (!record.ok) return [{ type: 'text', text: `${record.method}: ${record.hint ?? 'unknown method'}` }]
        const lines = [
          `${record.method}  [risk ${record.risk}${record.blocking ? ', BLOCKING' : ''}]`,
          `  what: ${record.summary}`,
          `  params (send exactly these): ${record.params?.length ? record.params.join(', ') : '(none read by the handler — see requires)'}`,
        ]
        if (record.requires?.length) lines.push(`  REQUIRED: ${record.requires.join(', ')}`)
        lines.push(`  returns: ${record.resultKeys?.length ? record.resultKeys.join(', ') : '(no result body)'}`)
        for (const nested of record.nested ?? []) lines.push(`    ${nested.name}: ${nested.keys.join(', ')}`)
        lines.push(`  codes: ${record.codes?.join(', ') ?? '200'}`)
        if (record.warning) lines.push(`  WARNING: ${record.warning}`)
        return [{ type: 'text', text: clip(lines.join('\n'), 12_000) }]
      },
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const method = args.method
      const spec = specOf(method)
      const known = METHOD_NAMES.includes(method)
      if (!spec || !known) {
        return {
          ok: false,
          method,
          risk: 'unknown',
          summary: 'not implemented by UnrealAgentLink',
          params: [],
          resultKeys: [],
          codes: [404],
          hint: (Object.hasOwn(BLACKLIST, method) ? BLACKLIST[method] : undefined) ?? `"${method}" is not a command this bridge knows. ual_tools lists what exists; names are dot-namespaced (actor.set_transform, not setTransform).`,
        }
      }
      const required = requiresOf(method)
      const params = [...new Set([...paramKeysOf(method), ...required])].sort()
      // Own-property lookup: the generated tables are object literals, so
      // `RESULT_KEYS['toString']` would return a function and the spread below
      // would throw instead of answering "not implemented".
      const resultKeys = [...new Set([...ownKeys(RESULT_KEYS, method), ...ownKeys(EXTRA_RESULT_KEYS, method)])].sort()
      const nested = Object.entries(NESTED_SHAPES)
        .filter(([, shape]) => shape.parent === method)
        .map(([name, shape]) => ({ name, parent: shape.parent, keys: [...shape.keys] }))
      return {
        ok: true,
        method,
        risk: spec.risk,
        summary: spec.summary,
        ...(required.length > 0 ? { requires: [...required] } : {}),
        params,
        resultKeys,
        codes: [...codesOf(method)],
        ...(spec.blocking ? { blocking: true } : {}),
        ...(spec.warning ? { warning: spec.warning } : {}),
        ...(nested.length > 0 ? { nested } : {}),
      }
    },
  })

  const ual_call = defineTool({
    name: 'ual_call',
    description:
      'Run one UnrealAgentLink command against the connected Unreal Editor and return its answer verbatim. This is the bridge to the whole engine API: actors, levels, blueprints, materials, widgets, PCG, landscapes, sequences, data tables, input, C++ builds, and console commands. Read the method name and its exact parameter keys from ual_tools / ual_schema first. Destructive and dangerous commands go through DSH approval. Params are snake_case, and unknown keys are ignored by the engine rather than rejected — so check the schema.',
    parameters: {
      method: { type: 'string', required: true, description: 'UAL method, e.g. "actor.get_info"' },
      params: { type: 'object', additionalProperties: true, description: 'the command parameters, exactly as ual_schema lists them' },
      timeoutMs: { type: 'integer', description: 'override the timeout for this one call; blocking commands already have a generous default' },
      noCache: { type: 'boolean', description: 'skip the per-session read cache and ask the editor again' },
    },
    output: { schema: CALL_OUTPUT, render: CALL_RENDER, presentationMeta: (_args, value) => value },
    timeoutMs: 20 * 60 * 1000,
    isConcurrencySafe: args => (args.method ? riskOf(args.method) === 'read' : false),
    presentCall: args => ({
      card: 'generic',
      title: `${args.method ?? 'ual_call'} (${riskOf(args.method ?? '')})`,
      kind: riskOf(args.method ?? '') === 'read' ? 'search' : 'edit',
      rawInput: args.params ?? {},
    }),
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const outcome = await service.call({
        method: args.method,
        ...(args.params !== undefined ? { params: args.params as Record<string, unknown> } : {}),
        ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
        ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
        session,
        signal: exec.signal,
        ...(args.noCache === true ? { noCache: true } : {}),
      })
      return outcome.value as never
    },
  })

  const ual_batch = defineTool({
    name: 'ual_batch',
    description:
      'Run several UnrealAgentLink commands in one tool call, in order, returning one result per call. Use it for a sequence you already know you need (spawn three actors, then inspect them; or five read-only queries) — it costs one tool round trip instead of five. Calls run serially because the editor executes them serially, and the batch stops on the first failure unless continueOnError is set. Prefer this over five ual_call turns; do not use it to hide a plan you have not thought through.',
    parameters: {
      calls: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: { method: { type: 'string', required: true }, params: { type: 'object', additionalProperties: true } },
        },
      },
      continueOnError: { type: 'boolean', description: 'keep going after a failure (default false: stop at the first one)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ran: { type: 'integer', required: true },
          succeeded: { type: 'integer', required: true },
          results: { type: 'array', items: { type: 'json' }, required: true },
          stopped_at: { type: 'integer' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as { ok: boolean; ran: number; succeeded: number; results: JsonValue[]; stopped_at?: number; hint?: string }
        const lines = [`batch: ${record.succeeded}/${record.ran} succeeded`]
        for (const [index, result] of record.results.entries()) lines.push(`  [${index}] ${clip(stringifyResult(result), 4_000)}`)
        if (record.hint) lines.push(`  note: ${record.hint}`)
        return [{ type: 'text', text: clip(lines.join('\n'), 24_000) }]
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: 20 * 60 * 1000,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const limit = service.config.maxBatchCalls
      if (args.calls.length === 0) {
        return { ok: false, ran: 0, succeeded: 0, results: [], hint: 'calls was empty' }
      }
      if (args.calls.length > limit) {
        return { ok: false, ran: 0, succeeded: 0, results: [], hint: `maxBatchCalls is ${limit}; split the batch or raise the plugin config` }
      }
      // Any dangerous method in a batch escalates the whole batch to approval:
      // a destructive call hidden at index 4 of five must not ride in on the
      // strength of four reads.
      const results: JsonValue[] = []
      let succeeded = 0
      for (const [index, entry] of args.calls.entries()) {
        const outcome = await service.call({
          method: entry.method,
          ...(entry.params !== undefined ? { params: entry.params as Record<string, unknown> } : {}),
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          session,
          signal: exec.signal,
        })
        results.push(jsonable(outcome.value))
        if (outcome.value.ok) succeeded += 1
        else if (!args.continueOnError) {
          return {
            ok: false,
            ran: index + 1,
            succeeded,
            results,
            stopped_at: index,
            hint: `stopped after "${entry.method}" failed; pass continueOnError:true to run the rest anyway`,
          }
        }
      }
      return { ok: succeeded === args.calls.length, ran: args.calls.length, succeeded, results }
    },
  })

  const ual_status = defineTool({
    name: 'ual_status',
    description:
      'Whether a Unreal Editor is connected to this bridge and what state the bridge is in: connected editors and their projects, the circuit breaker, rate limiter, this session\u2019s cached reads, its recorded undo steps, its asset locks, and any command that timed out and may still be running in the engine. Read this first when a command fails oddly, and after a timeout, before retrying anything.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true }, status: { type: 'json', required: true } } },
      render: (_args, value) => {
        const record = value as { ok: boolean; status: JsonObject }
        const status = record.status as {
          listening?: boolean
          url?: string
          editors?: JsonValue[]
          bound?: string
          breaker?: { state: string; retryAfterMs: number; reason: string }
          rate?: { perSecond: number; queued: number }
          cache?: { entries: number; ttlMs: number }
          steps?: number
          locks?: number
          logs?: { retained: number; forwarded: boolean }
          stale?: string[]
          pending?: number
          pendingMethods?: string[]
          orphaned?: string[]
        }
        const lines = [`listening: ${status.listening ? 'yes' : 'NO'} on ${status.url}`]
        if (!status.editors?.length) {
          lines.push('editors: none connected — open the project in Unreal Editor; the plugin dials in itself and retries every 5s')
        }
        for (const editor of status.editors ?? []) lines.push(`editor: ${brief(editor, 400)}`)
        if (status.bound) lines.push(`this session is bound to: ${status.bound}`)
        lines.push(`breaker: ${status.breaker?.state ?? 'closed'}${status.breaker && status.breaker.retryAfterMs > 0 ? ` (retry in ${Math.ceil(status.breaker.retryAfterMs / 1000)}s, reason: ${status.breaker.reason})` : ''}`)
        lines.push(`rate: ${status.rate?.perSecond}/s, ${status.rate?.queued} queued`)
        lines.push(`session state: ${status.steps} recorded step(s), ${status.locks} lock(s), ${status.cache?.entries} cached read(s) ttl ${status.cache?.ttlMs}ms`)
        lines.push(`logs: ${status.logs?.retained} retained, UE forwarding ${status.logs?.forwarded ? 'expected on' : 'OFF (set ual.ForwardLogs 1 in the editor)'}`)
        if (status.stale?.length) lines.push(`STALE (no heartbeat for 45s+): ${status.stale.join(', ')} — the editor is probably hung`)
        if (status.pending) lines.push(`in flight: ${status.pending} (${status.pendingMethods?.join(', ')})`)
        if (status.orphaned?.length) lines.push(`ORPHANED — timed out and not cancellable, may still be running: ${status.orphaned.join(', ')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const { session } = sessionOf(exec)
      return { ok: true, status: service.status(session) }
    },
  })

  return [ual_tools, ual_schema, ual_call, ual_batch, ual_status]
}

function stringifyResult(value: JsonValue): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * Own-property read of a generated table. `TABLE[method]` would reach
 * `Object.prototype` for a name like `toString` and return a function, which the
 * callers then spread.
 */
function ownKeys<T>(table: Record<string, readonly T[]>, method: string): readonly T[] {
  return Object.hasOwn(table, method) ? table[method]! : []
}

export { METHODS, riskOf }
