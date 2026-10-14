/**
 * Bridge behaviour over a real WebSocket pair.
 *
 * These tests exist because the interesting failures here are *temporal* and
 * invisible in a unit test of a pure function:
 *
 * - UE is a client that can vanish mid-command. The bridge cannot cancel work it
 *   already handed to the editor, so a timeout or an aborted `ual_task` leaves
 *   the editor busy. If that is not recorded, the next short call is queued
 *   behind work that may never answer — the bridge looks hung rather than honest.
 * - Per-editor queueing must survive a rejection, or one failure wedges that
 *   editor forever.
 *
 * A fake UE client speaks the real envelope (`ver`/`type`/`id`/`code`/`result`)
 * and is driven by the test, so no editor is needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { WebSocket } from 'ws'

import { UalBridge, NoEditorError, QueueStalledError, BridgeTimeoutError } from '../src/protocol/bridge.js'
import { UAL_VERSION } from '../src/protocol/types.js'

/** A port nobody else in the suite uses, so runs do not collide. */
let port = 17910
const nextPort = () => ++port

interface Frame {
  ver: string
  type: string
  method: string
  id?: string
  code?: number
  result?: unknown
  params?: unknown
}

/** A stand-in for the UE plugin: connects out and replies only when told to. */
class FakeEditor {
  readonly socket: WebSocket
  readonly received: Frame[] = []
  private readonly waiters: Array<(frame: Frame) => void> = []

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Frame
      const waiter = this.waiters.shift()
      // Hand the frame to a waiting reader, or buffer it — never both, or the
      // next `next()` would return the same request twice.
      if (waiter) waiter(frame)
      else this.received.push(frame)
    })
  }

  static connect(url: string): Promise<FakeEditor> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      socket.once('open', () => resolve(new FakeEditor(socket)))
      socket.once('error', reject)
    })
  }

  /** Resolve with the next request, or with one already buffered. */
  next(): Promise<Frame> {
    const buffered = this.received.shift()
    if (buffered) return Promise.resolve(buffered)
    return new Promise(resolve => this.waiters.push(resolve))
  }

  /** Announce the handshake UE sends on connect. */
  identify(projectName: string): void {
    this.socket.send(
      JSON.stringify({
        ver: UAL_VERSION,
        type: 'evt',
        method: 'project.info',
        payload: { projectName, projectPath: `/tmp/${projectName}`, engineVersion: '5.6.0' },
      }),
    )
  }

  reply(frame: Frame, result?: unknown, code = 200): void {
    this.socket.send(
      JSON.stringify({
        ver: UAL_VERSION,
        type: 'res',
        id: frame.id,
        method: frame.method,
        code,
        ...(result === undefined ? {} : { result }),
      }),
    )
  }

  close(): void {
    this.socket.close()
  }
}

let bridge: UalBridge
let editor: FakeEditor
let url: string

beforeEach(async () => {
  const p = nextPort()
  url = `ws://127.0.0.1:${p}`
  bridge = new UalBridge({ host: '127.0.0.1', port: p, timeoutMs: 400, logMinLevel: 'Display' })
  await bridge.listen()
  editor = await FakeEditor.connect(url)
  editor.identify('DemoProject')
  // `project.info` is handled synchronously on the socket's message event, but the
  // event loop still has to deliver it before `resolve()` can see the editor.
  await new Promise(resolve => setTimeout(resolve, 20))
})

afterEach(async () => {
  editor?.close()
  await bridge.stop()
})

describe('UalBridge: envelope and routing', () => {
  it('sends the exact envelope UE parses, with a server-minted id', async () => {
    const pending = bridge.send({ method: 'actor.get_info', params: { name: 'Cube' } })
    const frame = await editor.next()
    expect(frame).toEqual({
      ver: '1.0',
      type: 'req',
      method: 'actor.get_info',
      id: expect.stringMatching(/^dsh-/),
      params: { name: 'Cube' },
    })
    editor.reply(frame, { ok: true, actors: [] })
    expect(await pending).toEqual({ code: 200, result: { ok: true, actors: [] } })
  })

  it('omits the params key entirely when there are none', async () => {
    // UE reads params with TryGetObjectField; an explicit null is not the same
    // as an absent key, and `params: null` would fail closed differently.
    const pending = bridge.send({ method: 'system.get_project_info' })
    const frame = await editor.next()
    expect(Object.hasOwn(frame, 'params')).toBe(false)
    editor.reply(frame, { ok: true })
    await pending
  })

  it('surfaces the failure code and message from a non-200 reply', async () => {
    const pending = bridge.send({ method: 'actor.get' })
    const frame = await editor.next()
    editor.reply(frame, { message: '找不到 Actor' }, 404)
    await expect(pending).rejects.toMatchObject({ code: 404, message: '找不到 Actor' })
  })

  it('resolves 207 as a success that carries the partial code', async () => {
    const pending = bridge.send({ method: 'blueprint.compile' })
    const frame = await editor.next()
    editor.reply(frame, { ok: false, message: 'partial' }, 207)
    expect(await pending).toEqual({ code: 207, result: { ok: false, message: 'partial' } })
  })

  it('refuses to send when no editor is connected', async () => {
    await bridge.stop()
    bridge = new UalBridge({ host: '127.0.0.1', port: nextPort(), timeoutMs: 400 })
    await bridge.listen()
    await expect(bridge.send({ method: 'actor.get_info' })).rejects.toBeInstanceOf(NoEditorError)
  })
})

describe('UalBridge: a stalled editor must not look like a hung bridge', () => {
  it('records the orphan on timeout, then refuses the next short call', async () => {
    const stalled = bridge.send({ method: 'sequence.render' })
    await editor.next() // never answered: the game thread is still busy
    await expect(stalled).rejects.toBeInstanceOf(BridgeTimeoutError)

    // The editor never replied, so the bridge cannot know it finished. Refusing
    // beats queueing behind work that may never answer.
    await expect(bridge.send({ method: 'actor.get_info' })).rejects.toBeInstanceOf(QueueStalledError)
    expect(bridge.stats().orphanedMethods).toEqual(['sequence.render'])
  })

  it('still lets a long call through, because a long call is the way to wait it out', async () => {
    const stalled = bridge.send({ method: 'sequence.render' })
    await editor.next()
    await expect(stalled).rejects.toBeInstanceOf(BridgeTimeoutError)

    const long = bridge.send({ method: 'editor.save', long: true, timeoutMs: 1000 })
    const frame = await editor.next()
    editor.reply(frame, { ok: true })
    expect(await long).toEqual({ code: 200, result: { ok: true } })
    // A reply clears the stall.
    expect(bridge.stats().orphanedMethods).toEqual([])
  })

  it('records the orphan when an in-flight call is aborted', async () => {
    // `ual_task` kills by aborting our wait. The editor keeps running the
    // command, so the editor is just as stalled as after a timeout.
    const controller = new AbortController()
    const pending = bridge.send({ method: 'cmd.run_python', params: { script: 'x' }, signal: controller.signal })
    await editor.next()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    expect(bridge.stats().orphanedMethods).toEqual(['cmd.run_python'])
    await expect(bridge.send({ method: 'actor.get_info' })).rejects.toBeInstanceOf(QueueStalledError)
  })

  it('keeps the queue alive after a rejection', async () => {
    const failed = bridge.send({ method: 'actor.get' })
    const first = await editor.next()
    editor.reply(first, { message: 'nope' }, 404)
    await expect(failed).rejects.toMatchObject({ code: 404 })

    // One failure must not wedge the editor.
    const next = bridge.send({ method: 'actor.get_info' })
    const second = await editor.next()
    editor.reply(second, { ok: true })
    expect(await next).toEqual({ code: 200, result: { ok: true } })
  })

  it('serializes concurrent sends so one editor sees them one at a time', async () => {
    // Every UAL command runs on the game thread; interleaving them would make
    // "which edit landed first" unanswerable.
    const a = bridge.send({ method: 'actor.set_property' })
    const b = bridge.send({ method: 'actor.set_transform' })
    const first = await editor.next()
    expect(first.method).toBe('actor.set_property')
    // `b` must not have reached the wire while `a` is unanswered.
    expect(editor.received).toHaveLength(0)
    editor.reply(first, { ok: true })
    const second = await editor.next()
    expect(second.method).toBe('actor.set_transform')
    editor.reply(second, { ok: true })
    await Promise.all([a, b])
  })

  it('rejects in-flight calls when the editor disconnects', async () => {
    const pending = bridge.send({ method: 'actor.get_info' })
    await editor.next()
    editor.close()
    await expect(pending).rejects.toMatchObject({ name: 'EditorLostError' })
  })
})

describe('UalBridge: events from the editor', () => {
  it('marks the editor identified and reports it in stats', async () => {
    const stats = bridge.stats()
    expect(stats.editors).toHaveLength(1)
    expect(stats.editors[0]).toMatchObject({ project: 'DemoProject', engineVersion: '5.6.0' })
  })

  it('fails pending work when the editor reports the project closed', async () => {
    const pending = bridge.send({ method: 'actor.get_info' })
    await editor.next()
    editor.socket.send(
      JSON.stringify({ ver: UAL_VERSION, type: 'evt', method: 'project.closed', payload: {} }),
    )
    await expect(pending).rejects.toMatchObject({ name: 'EditorLostError' })
  })

  it('rings log entries and filters by the configured minimum level', async () => {
    const entry = (level: string, text: string) =>
      editor.socket.send(
        JSON.stringify({ ver: UAL_VERSION, type: 'evt', method: 'log.entry', payload: { level, category: 'LogTemp', text } }),
      )
    entry('Error', 'boom')
    entry('Verbose', 'chatty')
    await new Promise(resolve => setTimeout(resolve, 20))
    const texts = bridge.ringLogs.map(log => log.text)
    expect(texts).toContain('boom')
    // 'Verbose' is below the default 'Display' threshold.
    expect(texts).not.toContain('chatty')
  })

  it('emits the two reverse import requests instead of dropping them', async () => {
    const seen: string[] = []
    bridge.on(event => {
      if (event.type === 'import') seen.push(event.method)
    })
    for (const method of ['content.import_folder', 'content.import_assets']) {
      editor.socket.send(JSON.stringify({ ver: UAL_VERSION, type: 'evt', method, payload: { paths: ['/Game/A'] } }))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(seen).toEqual(['content.import_folder', 'content.import_assets'])
  })

  it('ignores a malformed frame instead of throwing', async () => {
    // UE drops an unparseable frame the same way, with no reply.
    editor.socket.send('{ not json')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.stats().failures).toBe(0)
  })

  it('ignores an evt whose method this bridge does not know', async () => {
    // The known vocabulary lives in `UalEventMethod` and is enforced by a
    // `satisfies` table, so an unknown name can only arrive from a NEWER editor
    // build. It must be dropped, not crash the session or count as a failure.
    const before = bridge.stats().editors[0]
    editor.socket.send(
      JSON.stringify({ ver: UAL_VERSION, type: 'evt', method: 'system.something_new', payload: { x: 1 } }),
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(bridge.stats().failures).toBe(0)
    expect(bridge.stats().editors).toHaveLength(1)
    // Still the same session, still identified: an unknown push changes nothing.
    expect(bridge.stats().editors[0]).toMatchObject({ sessionId: before?.sessionId, project: 'DemoProject' })
    expect(bridge.ringLogs).toHaveLength(0)
  })
})

describe('UalBridge: a half-connected editor must stay lossless JSON', () => {
  /**
   * `dsh-tools` snapshots every tool value with `snapshotJsonValue` BEFORE schema
   * validation, and that snapshot rejects any object property whose value is
   * `undefined`. So a field written as `x: maybe?.y` is not a harmless absent
   * value — it makes the whole tool result fail with
   * `ToolOutputError: value is not lossless JSON`.
   *
   * Two paths build records from an optional `session.info`, and both used to
   * write `project: session.info?.projectName`. `info` is genuinely absent between
   * the socket opening and `project.info` arriving, so:
   *   - `stats()` broke `ual_status`, the tool the model is told to read first,
   *     exactly when an editor showed up;
   *   - `rememberLog()` broke `ual_logs` for any log line forwarded in that window.
   * A field that is simply omitted is fine; one that is present and `undefined` is
   * not. These tests pin the omission.
   */
  const undefinedPaths = (value: unknown, path = 'value'): string[] => {
    if (value === null || typeof value !== 'object') return []
    if (Array.isArray(value)) return value.flatMap((entry, index) => undefinedPaths(entry, `${path}[${index}]`))
    return Reflect.ownKeys(value).flatMap(key => {
      const child = (value as Record<string, unknown>)[key as string]
      return child === undefined ? [`${path}.${String(key)}`] : undefinedPaths(child, `${path}.${String(key)}`)
    })
  }

  it('reports an editor that has not identified itself yet, without an undefined field', async () => {
    // A second, silent socket: connected, no `project.info` sent.
    const quiet = await FakeEditor.connect(url)
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      const stats = bridge.stats()
      const unidentified = stats.editors.find(record => record.sessionId !== stats.editors[0]?.sessionId)
      expect(stats.editors.length).toBeGreaterThanOrEqual(1)
      const fresh = stats.editors.at(-1)!
      expect(undefinedPaths(fresh)).toEqual([])
      // The project fields are ABSENT, not undefined.
      expect(Object.hasOwn(fresh, 'project')).toBe(false)
      expect(quiet.received.length).toBeGreaterThanOrEqual(0)
    } finally {
      quiet.close()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })

  it('rings a log line that arrives before the handshake, without an undefined project', async () => {
    // Replace the identified editor with a fresh socket that logs before identifying.
    editor.close()
    await new Promise(resolve => setTimeout(resolve, 20))
    const quiet = await FakeEditor.connect(url)
    try {
      quiet.socket.send(
        JSON.stringify({
          ver: UAL_VERSION,
          type: 'evt',
          method: 'log.entry',
          payload: { level: 'Error', category: 'LogTemp', text: 'early' },
        }),
      )
      await new Promise(resolve => setTimeout(resolve, 30))
      const entry = bridge.ringLogs.find(log => log.text === 'early')
      expect(entry, 'the early log line should be ringed').toBeDefined()
      expect(undefinedPaths(entry)).toEqual([])
      expect(Object.hasOwn(entry!, 'project')).toBe(false)
    } finally {
      quiet.close()
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  })
})

describe('UalBridge: loopback trust', () => {
  it('binds only the configured loopback address', async () => {
    const stats = bridge.stats()
    expect(stats.host).toBe('127.0.0.1')
    expect(stats.listening).toBe(true)
  })

  it('accepts a loopback peer, which is the only thing UE can be', async () => {
    // A non-loopback refusal needs a real remote address, which a local test
    // cannot produce; the acceptance path is what matters here.
    expect(bridge.stats().editors).toHaveLength(1)
  })
})

describe('UalBridge: shutdown', () => {
  it('rejects pending work and stops listening', async () => {
    const pending = bridge.send({ method: 'actor.get_info' })
    await editor.next()
    const stopping = bridge.stop()
    await expect(pending).rejects.toThrow(/shutting down/)
    await stopping
    expect(bridge.stats().listening).toBe(false)
  })

  it('refuses new sends once stopped', async () => {
    await bridge.stop()
    await expect(bridge.send({ method: 'actor.get_info' })).rejects.toThrow(/has been stopped/)
  })
})
