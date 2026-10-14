/**
 * Every tool's canonical value must satisfy the schema the tool itself declares.
 *
 * `dsh-tools` enforces this at dispatch time: `createSuccessResult` snapshots the
 * value, runs `validateJsonSchemaValue(tool.output.schema, value, 'value')`, and
 * throws `ToolOutputError` on any violation. The failure is not a warning and not
 * a degraded result — the model gets "output invalid" instead of the answer.
 *
 * The trap is `additionalProperties: false` on an output root, which is the
 * required style here. Declaring it turns the schema into a closed contract, so
 * every key the execute path can return must be listed. `ual_screenshot` shipped
 * with an undeclared `attachment` key and threw on exactly the path that matters
 * most — a screenshot that DID attach, i.e. the only case where the model gets to
 * see the level. Every other test passed, because nothing compared a real return
 * value against a real schema.
 *
 * There is a SECOND stage before the schema, and validating only against the
 * schema misses it: `snapshotToolValue` calls `snapshotJsonValue(value)` first and
 * throws `ToolOutputError(name, ['value is not lossless JSON'])` when it returns
 * undefined. That snapshot rejects any object property whose value is `undefined`
 * — stricter than the schema, and it fails FIRST. So `ual_status` threw whenever an
 * editor had connected but not yet sent `project.info`: `stats()` wrote
 * `project: undefined` on the editor record, and the model got "value is not
 * lossless JSON" instead of "one editor, not yet identified". An optional field
 * that is merely absent is fine; one that is present and `undefined` is not.
 *
 * So: run each tool through its happy path with a stub service, then apply the
 * snapshot and the schema in the order the registry does. A new tool with an
 * unlisted key, or with a conditional field written as `undefined`, fails here
 * instead of in front of a user.
 */
import { describe, it, expect } from 'vitest'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { makeGenericTools } from '../src/tools/generic.js'
import { makeOperationTools } from '../src/tools/operations.js'
import type { UalService } from '../src/service.js'
import type { ScreenshotReader } from '../src/tools/screenshot.js'

/** A rich `result` body, so response-shaping paths see every key they might copy. */
const RESULT = {
  ok: true,
  saved: true,
  path: 'K:/proj/Saved/Screenshots/Windows/x.png',
  filename: 'x.png',
  width: 1920,
  height: 1080,
  pending_shaders: 2,
  pending_assets: 1,
  streaming_in_flight: 0,
  world: 'editor',
  view: 'perspective',
  camera_source: 'viewport',
  exposure: 'auto',
  step_titles: ['A', 'B'],
  affected_packages: ['/Game/X'],
  affected_objects: ['/Game/X.Y'],
  steps_applied: 2,
  undoable: [{ title: 'A' }],
  redoable: [],
  count: 3,
  entries: [{ text: 'hi' }],
  ready: true,
}

const REF = { attachmentId: 'att_1', mediaType: 'image/png', bytes: 12, width: 4, height: 4 }

function serviceStub(): UalService {
  return {
    config: { maxBatchCalls: 12, logForwardingEnabled: false, screenshotAttachments: true, screenshotMaxBytes: 1 << 20 },
    sessions: {
      steps: () => 2,
      canRollbackLifo: () => true,
      state: () => ({ locks: new Set(['/Game/A']) }),
      mergedLocks: () => ['/Game/A'],
      clearLedger: () => {},
      invalidate: () => {},
      peek: () => ({ editor: 'ue-1' }),
    },
    breaker: { snapshot: () => ({ state: 'closed', retryAfterMs: 0 }) },
    limiter: { snapshot: () => ({ perSecond: 5, queued: 0 }) },
    call: async () => ({ value: { ok: true, method: 'm', result: RESULT, code: 200, elapsedMs: 1 } }),
    toolList: () => [{ method: 'actor.get', risk: 'read', summary: 's' }],
    logs: () => [{ seq: 1, at: 1, session: 's', level: 'Log', category: 'c', text: 't' }],
    latestLogSeq: () => 1,
    status: () => ({ listening: true, url: 'ws://127.0.0.1:17860', editors: [], steps: 0, locks: [], logs: { retained: 0, forwarded: false } }),
    locksPushed: () => true,
    pushLocksNow: async () => true,
    setLocks: () => {},
    clearLocks: () => {},
    bind: () => ({ bound: 'ue-1', pinned: true }),
  } as unknown as UalService
}

/** `attach` reports success, which is the path that must produce an image block. */
const screenshotsStub = {
  attach: async () => ({ attached: true, blocks: [{ type: 'image', attachment: REF }] }),
} as unknown as ScreenshotReader

/** One happy-path argument set per tool. A tool missing here is a test bug. */
const ARGS: Record<string, unknown> = {
  ual_tools: {},
  ual_schema: { method: 'actor.get' },
  ual_call: { method: 'actor.get' },
  ual_batch: { calls: [{ method: 'actor.get' }] },
  ual_status: {},
  ual_screenshot: { actors: ['A'] },
  ual_logs: {},
  ual_undo: { steps: 1 },
  ual_undo_history: {},
  ual_locks: { claim: ['/Game/A'] },
  ual_editor_bind: {},
  ual_task: { method: 'sequence.render' },
}

function tools(): ToolDefinition[] {
  const service = serviceStub()
  return [...makeGenericTools(service), ...makeOperationTools(service, screenshotsStub, () => undefined)]
}

function contextFor(tool: ToolDefinition, args: unknown): ToolRunContext {
  return {
    name: tool.name,
    arguments: args,
    callId: 'call-1',
    agent: { id: 'agent-1' },
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
}

/**
 * The registry's two stages, in order. `snapshotJsonValue` returning undefined is
 * `ToolOutputError(name, ['value is not lossless JSON'])`; the schema check follows
 * and is what `additionalProperties: false` enforces.
 */
function registryViolations(tool: ToolDefinition, value: unknown): string[] {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) return [`${tool.name} value is not lossless JSON`]
  return validateJsonSchemaValue(tool.output.schema, snapshot, 'value')
}

describe('tool outputs: the canonical value satisfies the declared schema', () => {
  it('covers every registered tool', () => {
    // Guards the guard: a new tool with no happy-path args would otherwise be
    // silently skipped by the loop below.
    expect(tools().map(tool => tool.name).sort()).toEqual(Object.keys(ARGS).sort())
  })

  for (const tool of tools()) {
    it(`${tool.name} returns a value its own schema accepts`, async () => {
      const args = ARGS[tool.name]
      const value = await tool.execute(args, contextFor(tool, args))
      const violations = registryViolations(tool, value)
      expect(violations, `${tool.name} output violations`).toEqual([])
    })
  }

  it('renders without throwing, for every tool', async () => {
    // `render` runs inside createSuccessResult too, and a throw there is reported
    // as an invalid output rather than a bug in the renderer.
    for (const tool of tools()) {
      const args = ARGS[tool.name]
      const value = await tool.execute(args, contextFor(tool, args))
      const blocks = tool.output.render(args, value as never)
      expect(blocks.length, `${tool.name} rendered nothing`).toBeGreaterThan(0)
    }
  })
})

describe('tool outputs: the failure path satisfies the declared schema too', () => {
  // Every tool that returns `ok: false` builds a DIFFERENT key set from its happy
  // path — usually the error/hint pair instead of the payload. A missing
  // declaration there throws on the one call where the model most needs to read
  // the reason, so the failure shape is validated separately.
  const FAILURE: Record<string, Record<string, unknown>> = {
    ual_screenshot: { ok: false, path: '', attached: false, error: 'no editor connected', hint: 'open the project' },
    ual_logs: { ok: false, count: 0, lastSeq: 0, entries: [], hint: 'open the project' },
    ual_undo: { ok: false, undone: 0, error: 'editor.undo refused', hint: 'read ual_undo_history' },
    ual_undo_history: { ok: false, error: 'editor.undo_history refused', hint: 'retry' },
    ual_locks: { ok: false, mine: [], merged: [], error: 'locks.set refused', hint: 'retry' },
  }

  for (const [name, value] of Object.entries(FAILURE)) {
    it(`${name} reports failure inside its schema`, () => {
      const tool = tools().find(candidate => candidate.name === name)
      expect(tool, `${name} is not a registered tool`).toBeDefined()
      const violations = registryViolations(tool!, value)
      expect(violations, `${name} failure-output violations`).toEqual([])
    })
  }
})

describe('tool outputs: a half-connected editor must not break ual_status', () => {
  /**
   * A socket connects a beat before it sends `project.info`, so the first
   * `ual_status` after an editor appears sees a session with no `info`. The
   * original `stats()` wrote `project: session.info?.projectName`, i.e. an own
   * property whose value is `undefined`, and `snapshotJsonValue` rejects that —
   * so `ual_status`, the tool the model is told to read first, threw
   * "value is not lossless JSON" at the exact moment an editor showed up.
   */
  const unidentified = {
    sessionId: 'ue-00000001',
    connectedAt: 1,
    lastSeenAt: 1,
    heartbeats: 0,
    stale: false,
  }

  it('accepts an editor record with no project fields at all', () => {
    const service = serviceStub() as unknown as { status: (session: string) => unknown }
    service.status = () => ({
      listening: true,
      url: 'ws://127.0.0.1:17860',
      editors: [unidentified],
      steps: 0,
      locks: 0,
      logs: { retained: 0, forwarded: false },
    })
    const tool = [...makeGenericTools(service as never)].find(candidate => candidate.name === 'ual_status')!
    return tool.execute({}, contextFor(tool, {})).then(value => {
      expect(registryViolations(tool, value)).toEqual([])
    })
  })

  it('has no own property whose value is undefined', () => {
    // The narrow invariant the registry actually enforces. Stated directly so a
    // future `x: maybe?.y` on any status field fails here with a clear name.
    const undefinedKeys = (value: unknown, path = 'status'): string[] => {
      if (value === null || typeof value !== 'object') return []
      if (Array.isArray(value)) return value.flatMap((entry, index) => undefinedKeys(entry, `${path}[${index}]`))
      return Reflect.ownKeys(value).flatMap(key =>
        (value as Record<string, unknown>)[key as string] === undefined
          ? [`${path}.${String(key)}`]
          : undefinedKeys((value as Record<string, unknown>)[key as string], `${path}.${String(key)}`),
      )
    }
    expect(undefinedKeys(unidentified)).toEqual([])
  })
})
