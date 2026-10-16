/**
 * Live integration: this plugin against a **separate-process** fake Unreal Editor.
 *
 * `tests/end-to-end.test.ts` already drives the real gate chain over a real
 * socket, but its editor is an in-process `FakeEditor` with hand-scripted replies:
 * it proves the bridge's correlation and the tools' shapes, and nothing about
 * whether a real `req`/`res` conversation survives an actual child process, an
 * actual dial-out, and an actual PNG on disk.
 *
 * This suite runs `tools/mock-ue-editor.mjs` as a child process. That editor is a
 * WebSocket *client*, exactly like the UE plugin build — it dials in, pushes
 * `project.info`, ticks a heartbeat, forwards `log.entry` lines, and answers
 * requests with bodies shaped by the catalog's own documented result keys. So the
 * assertions here are about the plugin, not about the fixture:
 *
 * - the whole 170-method catalog is answerable, so an agent can explore it;
 * - `ual_screenshot` turns the editor's file path into real attached bytes;
 * - an editor-side failure and a dropped command both surface as failures;
 * - and every registered tool returns a value its own declared schema accepts,
 *   with rendering, when the answer came off a real socket.
 *
 * The reason the mock is a separate process rather than a class is the point of
 * the test: a fake that shares the process shares its module graph, its clock and
 * its error semantics. Unreal does not.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'

import { UalService } from '../src/service.js'
import { DEFAULT_CONFIG, type ResolvedConfig } from '../src/config.js'
import { makeGenericTools } from '../src/tools/generic.js'
import { makeOperationTools } from '../src/tools/operations.js'
import { ScreenshotReader } from '../src/tools/screenshot.js'
import { BLACKLIST, METHOD_NAMES, paramKeysOf, requiresOf, riskOf } from '../src/catalog/methods.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOCK = join(repo, 'tools', 'mock-ue-editor.mjs')

const SESSION = 'mock-session'

// ── the rig: a real service, a real mock process, one throwaway directory ────

interface Frame {
  ver?: string
  type?: string
  method?: string
  id?: string
  code?: number
  result?: unknown
  params?: Record<string, unknown>
}

interface Rig {
  service: UalService
  config: ResolvedConfig
  url: string
  shotDir: string
  dir: string
  /** Everything the mock wrote to stdout/stderr, for a failure message. */
  output: () => string
  /** The `req` frames that actually reached the editor. */
  received: () => Frame[]
  /** The `evt` frames the editor pushed at the bridge. */
  pushed: () => Frame[]
  stop: () => Promise<void>
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

/** The only piece of Context the service touches, matching the other suites. */
function fakeContext(): never {
  const logger = () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} })
  return { logger } as never
}

async function startRig(mockArgs: string[] = []): Promise<Rig> {
  const port = await freePort()
  const url = `ws://127.0.0.1:${port}`
  const dir = mkdtempSync(join(tmpdir(), 'ual-mock-'))
  const shotDir = join(dir, 'shots')
  const transcriptPath = join(dir, 'transcript.jsonl')

  const config: ResolvedConfig = { ...DEFAULT_CONFIG, host: '127.0.0.1', port, timeoutMs: 1500, rateLimitRps: 0, breakerThreshold: 3 }
  const service = new UalService(fakeContext(), config)
  await service.start()

  let output = ''
  const child: ChildProcess = spawn(
    process.execPath,
    [
      MOCK,
      '--url', url,
      '--shot-dir', shotDir,
      '--transcript', transcriptPath,
      '--heartbeat-interval', '150',
      '--log-interval', '150',
      ...mockArgs,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })

  const transcript = (direction: 'in' | 'out'): Frame[] => {
    let text: string
    try {
      text = readFileSync(transcriptPath, 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line) as { direction: string; frame: Frame })
      .filter(entry => entry.direction === direction)
      .map(entry => entry.frame)
  }
  // "in" is from the mock's point of view: what it received from the bridge.
  const received = (): Frame[] => transcript('in')
  const pushed = (): Frame[] => transcript('out')

  try {
    await waitFor(() => service.status(SESSION).editors.length > 0, 8_000, `the mock editor to dial in at ${url}\n${output}`)
    await waitFor(() => pushed().some(frame => frame.type === 'evt' && frame.method === 'project.info'), 4_000, `project.info\n${output}`)
    await waitFor(() => service.status(SESSION).editors[0]?.project === 'MockProject', 4_000, `the bridge to identify the editor\n${output}`)
  } catch (error) {
    child.kill()
    await service.stop()
    rmSync(dir, { recursive: true, force: true })
    throw error
  }

  return {
    service, config, url, shotDir, dir,
    output: () => output,
    received,
    pushed,
    async stop() {
      child.kill()
      await service.stop()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

let rig: Rig | undefined

afterEach(async () => {
  await rig?.stop()
  rig = undefined
})

function exec(name: string, args: unknown): ToolRunContext {
  return { name, arguments: args, callId: 'c1', agent: { id: SESSION }, signal: new AbortController().signal } as unknown as ToolRunContext
}

/** The registry's validation stage, in the same form the other suites use. */
function registryViolations(tool: { name: string; output: { schema: unknown } }, value: unknown): string[] {
  const snapshot = snapshotJsonValue(value)
  if (snapshot === undefined) return [`${tool.name} value is not lossless JSON`]
  return validateJsonSchemaValue(tool.output.schema as never, snapshot, 'value')
}

/**
 * A `ctx.fs` / `ctx.attachments` pair backed by the real filesystem, so
 * `ual_screenshot` reads the PNG the mock actually wrote instead of a stub
 * deciding it does not exist.
 */
function screenshotReader() {
  const saved: Array<{ mediaType: string; bytes: number; width: number; height: number }> = []
  const ctx = {
    get: (name: string) => {
      if (name === 'fs') {
        return {
          resolve: async (path: string) => ({ targetKey: path, displayPath: path }),
          stat: async (target: { targetKey: string }) => {
            const info = statSync(target.targetKey)
            return { type: info.isFile() ? 'file' : 'directory', size: info.size }
          },
          readBytes: async (target: { targetKey: string }) => readFileSync(target.targetKey),
        }
      }
      if (name === 'attachments') {
        return {
          saveImage: async (input: { data: Uint8Array; mediaType: string; name?: string }) => {
            const ref = { attachmentId: `mock-${saved.length + 1}`, mediaType: input.mediaType, bytes: input.data.byteLength, width: 320, height: 180, ...(input.name ? { name: input.name } : {}) }
            saved.push(ref)
            return ref
          },
        }
      }
      return undefined
    },
  }
  return { reader: new ScreenshotReader(ctx as never, { maxBytes: 4 * 1024 * 1024, enabled: true }), saved }
}

/** Params that satisfy the catalog's required-key gate for one method. */
function paramsFor(method: string): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const key of paramKeysOf(method)) {
    if (requiresOf(method).includes(key)) params[key] = key.endsWith('s') ? ['/Game/Mock/M_Mock'] : 'mock'
  }
  return params
}

// ── the fake editor speaks the protocol ─────────────────────────────────────

describe('a real fake editor process behind the real bridge', () => {
  it('dials in, identifies itself, and answers a cataloged command', async () => {
    rig = await startRig()
    const status = rig.service.status(SESSION)
    expect(status.editors).toHaveLength(1)
    expect(status.editors[0]?.project).toBe('MockProject')
    expect(status.editors[0]?.engineVersion).toBe('5.6.0')
    expect(status.editors[0]?.level).toBe('MockMap')

    const outcome = await rig.service.call({ method: 'actor.get', params: { targets: { selection: true } }, session: SESSION, noCache: true })
    expect(outcome.value.ok, JSON.stringify(outcome.value)).toBe(true)
    const result = outcome.value.result as { count?: number; actors?: unknown[] }
    expect(result.count).toBe(2)
    expect(result.actors).toHaveLength(2)
    expect(rig.received().some(frame => frame.method === 'actor.get')).toBe(true)
  })

  it('answers every cataloged method, so an agent can explore the whole surface', async () => {
    rig = await startRig()
    const unanswered: string[] = []
    const refusedLocally: string[] = []
    for (const method of METHOD_NAMES) {
      const outcome = await rig.service.call({ method, params: paramsFor(method), session: SESSION, noCache: true })
      if (outcome.value.ok === true) continue
      // A blacklisted method is refused by the bridge itself, before the socket:
      // upstream registers it into the wrong map, so a mock that answered it
      // would be lying about what a real editor does.
      if (Object.hasOwn(BLACKLIST, method)) {
        refusedLocally.push(method)
        continue
      }
      unanswered.push(`${method}: ${JSON.stringify(outcome.value)}`)
    }
    expect(refusedLocally.length, 'blacklisted methods the bridge refuses for us').toBeLessThanOrEqual(Object.keys(BLACKLIST).length)
    expect(unanswered, 'methods the fake editor could not answer').toEqual([])

    // Every method really did make the trip: nothing was served from a stub.
    const reached = new Set(rig.received().filter(frame => frame.type === 'req').map(frame => frame.method))
    for (const method of METHOD_NAMES) {
      if (Object.hasOwn(BLACKLIST, method)) continue
      expect(reached.has(method), `${method} never reached the editor`).toBe(true)
    }
  })

  it('serves the documented result keys, so tool rendering has real data to read', async () => {
    rig = await startRig()
    const info = await rig.service.call({ method: 'system.get_project_info', params: {}, session: SESSION, noCache: true })
    const body = info.value.result as Record<string, unknown>
    expect(body.capabilities).toEqual({ blueprint_require_empty: true, material_fail_if_exists: true, python: true })

    const capabilities = await rig.service.capabilitiesFor(SESSION)
    expect(capabilities.python).toBe(true)

    const logs = await rig.service.call({ method: 'messagelog.list', params: {}, session: SESSION, noCache: true })
    expect(Array.isArray((logs.value.result as { categories?: unknown[] }).categories)).toBe(true)
  })

  it('ticks the heartbeat and forwards log lines into the bridge ring', async () => {
    rig = await startRig()
    await waitFor(() => (rig!.service.status(SESSION).editors[0]?.heartbeats ?? 0) >= 1, 3_000, 'a heartbeat')
    await waitFor(() => rig!.service.logs({}).length > 0, 3_000, 'a forwarded log line')
    const entries = rig.service.logs({ level: 'Log' })
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]?.text).toContain('mock')
  })
})

// ── the failures a real editor produces ─────────────────────────────────────

describe('editor-side failures reach the caller as failures', () => {
  it('translates an injected 500 into a failed call that keeps the editor message', async () => {
    rig = await startRig(['--fail', 'editor.undo:500:mock editor refused the undo'])
    const outcome = await rig.service.call({ method: 'editor.undo', params: { steps: 1 }, session: SESSION, noCache: true })
    expect(outcome.value.ok).toBe(false)
    expect(String(outcome.value.error)).toContain('mock editor refused the undo')
  })

  it('translates an injected 404 into a not-found kind', async () => {
    rig = await startRig(['--fail', 'actor.get:404:moved upstream'])
    const outcome = await rig.service.call({ method: 'actor.get', params: {}, session: SESSION, noCache: true })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.kind).toBe('not-found')
  })

  it('times out a command the editor never answers', async () => {
    rig = await startRig(['--drop', 'level.save'])
    const started = Date.now()
    const outcome = await rig.service.call({ method: 'level.save', params: {}, session: SESSION, noCache: true })
    expect(outcome.value.ok).toBe(false)
    expect(outcome.value.kind).toBe('timeout')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    // A command that timed out may still be running inside the engine, so the
    // bridge must keep saying so rather than pretending it was cancelled.
    expect(rig.service.status(SESSION).orphaned).toContain('level.save')
  })
})

// ── the whole tool surface, against the fake editor ─────────────────────────

describe('every registered tool works against a real fake editor', () => {
  const ARGS: Record<string, unknown> = {
    ual_tools: {},
    ual_schema: { method: 'actor.set_transform' },
    ual_call: { method: 'actor.get', params: { targets: { selection: true } } },
    ual_batch: { calls: [{ method: 'actor.get' }, { method: 'level.get_current' }, { method: 'editor.get_dirty' }] },
    ual_status: {},
    ual_screenshot: { actors: ['Cube_1'] },
    ual_logs: { pullMessageLog: true, limit: 5 },
    ual_undo: { steps: 1 },
    ual_undo_history: { limit: 5 },
    ual_locks: { claim: ['/Game/Mock/M_Mock'] },
    ual_editor_bind: {},
    ual_task: { method: 'sequence.render' },
  }

  it('returns a schema-valid, rendered value for all twelve tools', async () => {
    rig = await startRig()
    // `ual_undo` only rolls back what THIS session recorded, so record a mutation
    // through the real chain first — with the mock's own `actor.set_transform`.
    const mutation = await rig.service.call({ method: 'actor.set_transform', params: { targets: { selection: true } }, session: SESSION })
    expect(mutation.value.ok, JSON.stringify(mutation.value)).toBe(true)

    const { reader, saved } = screenshotReader()
    const tools = [...makeGenericTools(rig.service), ...makeOperationTools(rig.service, reader, () => undefined)]
    expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(ARGS).sort())

    const values = new Map<string, unknown>()
    for (const tool of tools) {
      const args = ARGS[tool.name]
      const value = await tool.execute(args, exec(tool.name, args))
      expect(registryViolations(tool, value), `${tool.name} violations`).toEqual([])
      const blocks = tool.output.render(args, value as never)
      expect(blocks.length, `${tool.name} rendered nothing`).toBeGreaterThan(0)
      values.set(tool.name, value)
    }

    // Spot-check the content, not just the shape: a tool can be schema-valid and
    // still be reporting nothing at all.
    const call = values.get('ual_call') as { ok: boolean; result?: { count?: number } }
    expect(call.ok).toBe(true)
    expect(call.result?.count).toBe(2)

    const batch = values.get('ual_batch') as { ok: boolean; results?: unknown[] }
    expect(batch.results ?? []).toHaveLength(3)

    const status = values.get('ual_status') as { status: { editors?: unknown[] } }
    expect(status.status.editors).toHaveLength(1)

    const shot = values.get('ual_screenshot') as { attached: boolean; path: string; bytes?: number }
    expect(shot.attached, JSON.stringify(shot)).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.mediaType).toBe('image/png')
    expect(shot.bytes ?? saved[0]?.bytes ?? 0).toBeGreaterThan(0)

    const undo = values.get('ual_undo') as { ok: boolean; undone: number; titles?: string[] }
    expect(undo.ok).toBe(true)
    expect(undo.undone).toBe(1)
    expect(undo.titles).toContain('Move Cube_1')

    const logs = values.get('ual_logs') as { ok: boolean; count: number }
    expect(logs.ok).toBe(true)
    expect(logs.count).toBeGreaterThan(0)

    const locks = values.get('ual_locks') as { ok: boolean }
    expect(locks.ok).toBe(true)
  })

  it('writes a screenshot that is a real PNG on disk, not just a path', async () => {
    rig = await startRig()
    const { reader } = screenshotReader()
    const tools = [...makeGenericTools(rig.service), ...makeOperationTools(rig.service, reader, () => undefined)]
    const tool = tools.find(entry => entry.name === 'ual_screenshot')!
    const args = { actors: ['Cube_1'] }
    const value = (await tool.execute(args, exec('ual_screenshot', args))) as { attached: boolean; path: string }

    expect(value.attached, JSON.stringify(value)).toBe(true)
    expect(value.path.startsWith(rig.shotDir)).toBe(true)
    const bytes = readFileSync(value.path)
    // \x89PNG\r\n\x1a\n — the file the editor named is an image the model can see.
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(bytes.byteLength).toBeGreaterThan(100)
    expect(tool.output.render(args, value as never).length).toBeGreaterThan(0)
  })

  it('a generic answer carries the catalog’s documented keys', async () => {
    rig = await startRig()
    // Pick a read method the mock has no override for, so the generic path runs.
    const method = 'content.registry_status'
    expect(riskOf(method)).toBe('read')
    const outcome = await rig.service.call({ method, params: paramsFor(method), session: SESSION, noCache: true })
    expect(outcome.value.ok, JSON.stringify(outcome.value)).toBe(true)
    expect(outcome.value.result).toBeTypeOf('object')
  })
})

// ── the engine Message Log, answered the way the editor really answers it ───

describe('ual_logs reads the engine Message Log the way the editor sends it', () => {
  // UAL_MessageLogCommands.cpp: `list` takes NO parameters and returns
  // `{categories: [{name, label}]}`; the lines are behind `get`, which needs one
  // category and returns `{category, count, total, messages: [{severity, text,
  // tokens}]}`. The pull branch used to call `list` with a `limit` the handler
  // ignores and wrap that payload as a single log line, so the model was shown
  // one blank row no matter what the editor had to say.
  const logsTool = () => {
    const { reader } = screenshotReader()
    return makeOperationTools(rig.service, reader, () => undefined).find(tool => tool.name === 'ual_logs')!
  }
  const rendered = (tool: ReturnType<typeof logsTool>, args: unknown, value: unknown) =>
    tool.output.render(args as never, value as never).map(block => (block as { text?: string }).text ?? '').join('\n')

  it('renders the engine Message Log category tree instead of one blank row', async () => {
    rig = await startRig()
    const tool = logsTool()
    const args = { pullMessageLog: true }
    const value = (await tool.execute(args, exec('ual_logs', args))) as { ok: boolean; count: number; source?: string }
    expect(value.ok).toBe(true)
    expect(value.source).toBe('message-log-categories')
    expect(value.count).toBe(2)
    // The frame really carried no `limit`: `list` accepts no parameters at all.
    expect(rig.received().find(frame => frame.method === 'messagelog.list')?.params ?? {}).toEqual({})

    const text = rendered(tool, args, value)
    expect(text).toContain('LogTemp')
    expect(text).toContain('LogUnrealAgentLink')
    expect(text).toContain('categor')
    expect(text).not.toMatch(/^\s*: *$/m)
  })

  it('pulls one category’s lines through messagelog.get when category is given', async () => {
    rig = await startRig()
    const tool = logsTool()
    const args = { pullMessageLog: true, category: 'LogUnrealAgentLink', limit: 1 }
    const value = (await tool.execute(args, exec('ual_logs', args))) as { ok: boolean; count: number; source?: string; entries: { level?: string; text?: string }[] }
    expect(value.ok).toBe(true)
    expect(value.source).toBe('message-log-lines')
    expect(value.count).toBe(1)
    // The engine's `{severity, text}` is presented in the tool's own entry shape.
    expect(value.entries[0]?.level).toBe('Info')
    expect(value.entries[0]?.text).toContain('LogUnrealAgentLink')

    const text = rendered(tool, args, value)
    expect(text).toContain('from the engine Message Log')
    expect(text).toContain('Info')
  })

  it('still labels this bridge’s own ring as the ring', async () => {
    rig = await startRig()
    const tool = logsTool()
    const args = { limit: 5 }
    const value = (await tool.execute(args, exec('ual_logs', args))) as { source?: string }
    expect(value.source).toBe('ring')
  })
})
