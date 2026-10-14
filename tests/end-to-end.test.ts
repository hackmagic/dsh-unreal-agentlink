/**
 * End-to-end: a real `UalService` behind a real WebSocket, driven by a fake editor.
 *
 * The other suites test pieces: `tool-output` stubs the service, `bridge` stubs the
 * service layer, `catalog` checks the tables. None of them exercises the one path
 * that actually runs in production — `service.call()`'s gate chain (catalog →
 * requires → read cache → breaker → rate limit → send → ledger → translate) wired
 * to a live socket, with the returned value handed to a tool's declared schema.
 *
 * That gap is exactly where the wiring bugs live, because a stub service can be
 * internally consistent while the real chain is not. The `requires` gate is the
 * concrete example: `REQUIRED_KEYS` was generated, documented and reviewed, but
 * never imported, so `service.call()`'s pre-rejection was dead code and no unit
 * test noticed — the stub returned whatever the test wanted. Here the gate is real.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { UalService } from '../src/service.js'
import { DEFAULT_CONFIG, type ResolvedConfig } from '../src/config.js'
import { UAL_VERSION } from '../src/protocol/types.js'
import { makeGenericTools } from '../src/tools/generic.js'
import { makeOperationTools } from '../src/tools/operations.js'

let port = 18010
const nextPort = () => ++port

interface Frame {
  ver: string
  type: string
  method: string
  id?: string
  code?: number
  result?: unknown
  params?: Record<string, unknown>
}

/** A fake editor that answers every request with a scripted reply. */
class FakeEditor {
  readonly socket: WebSocket
  readonly seen: Frame[] = []
  private readonly waiters: Array<(frame: Frame) => void> = []
  /** method → reply. A missing method answers 404, like the real dispatcher. */
  replies = new Map<string, { code: number; result?: unknown }>()
  /** Every request the bridge sent, for asserting on params. */
  requests: Frame[] = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame
      this.requests.push(frame)
      const scripted = this.replies.get(frame.method) ?? { code: 404, result: { message: `Unknown method: ${frame.method}` } }
      socket.send(JSON.stringify({ ver: UAL_VERSION, type: 'res', id: frame.id, method: frame.method, code: scripted.code, ...(scripted.result === undefined ? {} : { result: scripted.result }) }))
      const waiter = this.waiters.shift()
      if (waiter) waiter(frame)
      else this.seen.push(frame)
    })
  }

  static connect(url: string): Promise<FakeEditor> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.once('open', () => resolve(new FakeEditor(socket)))
      socket.once('error', reject)
    })
  }

  identify(projectName = 'DemoProject'): void {
    this.socket.send(JSON.stringify({ ver: UAL_VERSION, type: 'evt', method: 'project.info', payload: { projectName, projectPath: `/tmp/${projectName}`, engineVersion: '5.6.0' } }))
  }

  close(): void {
    this.socket.close()
  }
}

/** The only piece of Context the service touches. */
function fakeContext() {
  const lines: string[] = []
  const logger = () => ({ info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m), debug: () => {} })
  return { ctx: { logger } as never, lines }
}

let service: UalService
let editor: FakeEditor
let config: ResolvedConfig
let url: string

beforeEach(async () => {
  const p = nextPort()
  url = `ws://127.0.0.1:${p}`
  config = { ...DEFAULT_CONFIG, host: '127.0.0.1', port: p, timeoutMs: 500, rateLimitRps: 0, breakerThreshold: 3 }
  service = new UalService(fakeContext().ctx, config)
  await service.start()
  editor = await FakeEditor.connect(url)
  editor.identify()
  await new Promise(resolve => setTimeout(resolve, 20))
})

afterEach(async () => {
  editor?.close()
  await service.stop()
})

function exec(name: string, args: unknown): ToolRunContext {
  return { name, arguments: args, callId: 'c1', agent: { id: 'session-1' }, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** The registry's two stages, in the order dsh-tools applies them. */
function registryViolations(tool: { name: string; output: { schema: unknown } }, value: unknown): string[] {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) return [`${tool.name} value is not lossless JSON`]
  return validateJsonSchemaValue(tool.output.schema as never, snapshot, 'value')
}

describe('end to end: the real gate chain over a live socket', () => {
  it('sends a real request and returns the editor body', async () => {
    editor.replies.set('actor.get', { code: 200, result: { ok: true, actors: [{ name: 'Cube' }] } })
    const outcome = await service.call({ method: 'actor.get', params: { targets: { selection: true } }, session: 'session-1' })
    expect(outcome.value.ok).toBe(true)
    expect(outcome.value.result).toEqual({ ok: true, actors: [{ name: 'Cube' }] })
    expect(editor.requests[0]!.method).toBe('actor.get')
  })

  it('pre-rejects a call missing a derived required key, without touching the socket', async () => {
    // `cmd.run_python` requires `script`, derived from the handler's own
    // `Missing field: script` 400. If `REQUIRED_KEYS` is not wired in, this call
    // reaches the editor and gets a 404 here (no scripted reply) instead — so this
    // assertion fails loudly rather than silently passing.
    const outcome = await service.call({ method: 'cmd.run_python', params: {}, session: 'session-1' })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.kind).toBe('bad-params')
    expect(outcome.value.error).toContain('script')
    expect(editor.requests, 'nothing should have been sent to the editor').toHaveLength(0)
  })

  it('does not pre-reject a call whose required keys are satisfied', async () => {
    editor.replies.set('cmd.run_python', { code: 200, result: { ok: true } })
    const outcome = await service.call({ method: 'cmd.run_python', params: { script: 'print(1)' }, session: 'session-1' })
    expect(outcome.value.ok).toBe(true)
    expect(editor.requests).toHaveLength(1)
  })

  it('does not pre-reject a method whose keys are branch-local', async () => {
    // `input.add_mapping` only needs `key`; the legacy dispatch reaches
    // AddLegacyMapping which needs `name` instead of context_path/action_path.
    editor.replies.set('input.add_mapping', { code: 200, result: { ok: true } })
    const outcome = await service.call({ method: 'input.add_mapping', params: { key: 'EKeys::SpaceBar', system: 'legacy', name: 'Jump' }, session: 'session-1' })
    expect(outcome.value.ok).toBe(true)
  })

  it('rejects an unknown method without forwarding it', async () => {
    const outcome = await service.call({ method: 'nope.nope', params: {}, session: 'session-1' })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.kind).toBe('unknown-method')
    expect(editor.requests).toHaveLength(0)
  })

  it('surfaces a handler-level failure (200 + ok:false) as a failure', async () => {
    editor.replies.set('editor.undo', { code: 200, result: { ok: false, error: 'nothing to undo', message: 'nothing to undo' } })
    const outcome = await service.call({ method: 'editor.undo', params: { steps: 1 }, session: 'session-1' })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.error).toBeTruthy()
  })

  it('translates a 404 from the editor into a not-found kind', async () => {
    // No scripted reply → the fake answers 404, which is what the real dispatcher
    // does for an unregistered method.
    const outcome = await service.call({ method: 'actor.get', params: {}, session: 'session-1' })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.kind).toBe('not-found')
  })

  it('records a mutation in the session ledger and caches a read', async () => {
    editor.replies.set('actor.set_transform', { code: 200, result: { ok: true, affected_packages: ['/Game/Maps/L'] } })
    await service.call({ method: 'actor.set_transform', params: { targets: { selection: true } }, session: 'session-1' })
    expect(service.sessions.steps('session-1')).toBe(1)

    editor.replies.set('actor.get', { code: 200, result: { ok: true } })
    await service.call({ method: 'actor.get', params: { targets: { selection: true } }, session: 'session-1' })
    const before = editor.requests.length
    const cached = await service.call({ method: 'actor.get', params: { targets: { selection: true } }, session: 'session-1' })
    expect(cached.value.cached).toBe(true)
    expect(editor.requests.length, 'a cache hit must not hit the socket').toBe(before)
  })
})

describe('end to end: tool values from the real service satisfy their schemas', () => {
  // The stub-based tool-output suite cannot catch a service/type mismatch, because
  // the stub decides the shape. Here the shape comes from the real chain.
  const ARGS: Record<string, unknown> = {
    ual_tools: {}, ual_schema: { method: 'actor.get' }, ual_call: { method: 'actor.get' },
    ual_batch: { calls: [{ method: 'actor.get' }] }, ual_status: {},
    ual_screenshot: { actors: ['A'] }, ual_logs: {}, ual_undo: { steps: 1 },
    ual_undo_history: {}, ual_locks: { claim: ['/Game/A'] }, ual_editor_bind: {},
    ual_task: { method: 'sequence.render' },
  }

  it('every tool returns a value its own schema accepts, against the live service', async () => {
    editor.replies.set('actor.get', { code: 200, result: { ok: true, actors: [] } })
    editor.replies.set('editor.undo_history', { code: 200, result: { ok: true, undoable: 1, redoable: 0, entries: [{ title: 'A' }] } })
    editor.replies.set('editor.undo', { code: 200, result: { ok: true, steps_applied: 1, step_titles: ['A'] } })
    editor.replies.set('locks.set', { code: 200, result: { ok: true, locked: 1 } })
    editor.replies.set('editor.screenshot', { code: 200, result: { saved: true, path: 'K:/nope/x.png' } })
    editor.replies.set('editor.capture_app_window', { code: 200, result: { saved: true, path: 'K:/nope/x.png' } })
    editor.replies.set('messagelog.list', { code: 200, result: { ok: true, entries: [] } })

    const shots = { attach: async () => ({ attached: false, blocks: [], reason: 'no fs in this test' }) } as never
    const tools = [...makeGenericTools(service), ...makeOperationTools(service, shots, () => undefined)]
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(ARGS).sort())

    for (const tool of tools) {
      const args = ARGS[tool.name]
      const value = await tool.execute(args, exec(tool.name, args))
      expect(registryViolations(tool, value), `${tool.name} violations`).toEqual([])
      expect(tool.output.render(args, value as never).length, `${tool.name} rendered nothing`).toBeGreaterThan(0)
    }
  })
})
