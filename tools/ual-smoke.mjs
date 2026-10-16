#!/usr/bin/env node
/**
 * Run the whole plugin against the fake editor, with no Unreal Engine installed.
 *
 * This is the human entry point: it starts a real `UalService` (the same class
 * `apply()` starts in dsh), launches `tools/mock-ue-editor.mjs` as a child
 * process, waits for it to dial in, then calls **every** registered tool the way
 * the model would, prints what each one rendered, and validates each returned
 * value against the tool's own declared output schema. A non-zero exit means a
 * tool produced something the registry would reject.
 *
 * ```console
 * npm run smoke                    # everything, into ./.smoke
 * npm run smoke -- --out /tmp/ual  # somewhere else
 * npm run smoke -- --method actor.get   # one catalog method through ual_call
 * npm run smoke -- --port 17861    # if 17860 is taken by a real UEBox
 * ```
 *
 * It is deliberately not a unit test: the automated equivalent lives in
 * `tests/mock-editor.test.ts`, which asserts the same wiring. This script exists
 * so a person can watch it happen and keep the screenshot it produced.
 *
 * @module tools/ual-smoke
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'

import { UalService } from '../lib/service.js'
import { DEFAULT_CONFIG } from '../lib/config.js'
import { makeGenericTools } from '../lib/tools/generic.js'
import { makeOperationTools } from '../lib/tools/operations.js'
import { ScreenshotReader } from '../lib/tools/screenshot.js'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOCK = join(repo, 'tools', 'mock-ue-editor.mjs')
const SESSION = 'smoke-session'

// ── arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const port = Number(flag('port', '0')) || undefined
const outDir = resolve(repo, flag('out', '.smoke'))
const only = flag('method', undefined)
const keepMock = argv.includes('--keep-mock')
const verbose = argv.includes('--verbose')

function line(text = '') {
  process.stdout.write(`${text}\n`)
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const chosen = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(chosen))
    })
  })
}

async function waitFor(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`)
}

// ── the filesystem/attachment shim the screenshot reader needs ──────────────

const attachments = []

function screenshotReader() {
  const ctx = {
    get: (name) => {
      if (name === 'fs') {
        return {
          resolve: async (path) => ({ targetKey: path, displayPath: path }),
          stat: async (target) => {
            const info = statSync(target.targetKey)
            return { type: info.isFile() ? 'file' : 'directory', size: info.size }
          },
          readBytes: async (target) => readFileSync(target.targetKey),
        }
      }
      if (name === 'attachments') {
        return {
          saveImage: async (input) => {
            const ref = {
              attachmentId: `smoke-attachment-${attachments.length + 1}`,
              mediaType: input.mediaType,
              bytes: input.data.byteLength,
              width: 320,
              height: 180,
              ...(input.name ? { name: input.name } : {}),
            }
            attachments.push(ref)
            return ref
          },
        }
      }
      return undefined
    },
  }
  return new ScreenshotReader(ctx, { maxBytes: 8 * 1024 * 1024, enabled: true })
}

// ── main ────────────────────────────────────────────────────────────────────

const chosenPort = port ?? (await freePort())
const url = `ws://127.0.0.1:${chosenPort}`
mkdirSync(outDir, { recursive: true })

const config = {
  ...DEFAULT_CONFIG,
  host: '127.0.0.1',
  port: chosenPort,
  timeoutMs: 5_000,
  rateLimitRps: 0,
}
const logger = () => ({ info: () => {}, warn: (...parts) => line(`warn: ${parts.join(' ')}`), error: (...parts) => line(`error: ${parts.join(' ')}`), debug: () => {} })
const service = new UalService({ logger }, config)

line(`smoke: bridge listening on ${url}`)
await service.start()

const mockArgs = [
  '--url', url,
  '--shot-dir', join(outDir, 'shots'),
  '--transcript', join(outDir, 'transcript.jsonl'),
  // A real editor ticks every 10 s and forwards logs every 2 s; a smoke run is
  // over in under a second, so speed both up and let the ring actually fill.
  '--heartbeat-interval', '50',
  '--log-interval', '50',
]
const child = spawn(process.execPath, [MOCK, ...mockArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
let mockOutput = ''
child.stdout.on('data', (chunk) => { mockOutput += String(chunk); if (verbose) process.stdout.write(String(chunk)) })
child.stderr.on('data', (chunk) => { mockOutput += String(chunk); process.stdout.write(String(chunk)) })

let failed = 0

function cleanup() {
  if (keepMock) line(`smoke: --keep-mock, leaving the editor (pid ${child.pid}) attached`)
  else child.kill()
}

try {
  await waitFor(() => service.status(SESSION).editors.length > 0, 10_000, `the fake editor to dial in\n${mockOutput}`)
  await waitFor(() => service.status(SESSION).editors[0]?.project === 'MockProject', 5_000, `the editor to identify\n${mockOutput}`)
  const editor = service.status(SESSION).editors[0]
  line(`smoke: fake editor attached — ${editor.project} / UE ${editor.engineVersion} / level ${editor.level}`)
  // Let one heartbeat and one forwarded log line land, so `ual_status` shows a
  // ring that is actually doing something instead of a row of zeroes.
  await waitFor(() => (service.status(SESSION).logs?.retained ?? 0) > 0, 3_000, `a forwarded log line\n${mockOutput}`)
  line()

  const tools = [...makeGenericTools(service), ...makeOperationTools(service, screenshotReader(), () => undefined)]

  if (only) {
    const outcome = await service.call({ method: only, params: {}, session: SESSION, noCache: true })
    line(`smoke: ${only} -> ${outcome.value.ok ? 'ok' : `FAILED (${outcome.value.kind ?? 'error'})`}`)
    line(JSON.stringify(outcome.value.result ?? outcome.value.error, null, 2))
    if (outcome.value.ok !== true) failed += 1
  } else {
    // One mutation first, so `ual_undo` has something this session really did.
    const mutation = await service.call({ method: 'actor.set_transform', params: { targets: { selection: true } }, session: SESSION })
    line(`smoke: recorded a mutation (actor.set_transform) -> ${mutation.value.ok ? 'ok' : 'FAILED'}`)
    line()

    const callArgs = {
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
      ual_editor_bind: { editor: 'MockProject' },
      ual_task: { method: 'sequence.render' },
    }

    for (const tool of tools) {
      const args = callArgs[tool.name]
      if (!args) continue
      const exec = { name: tool.name, arguments: args, callId: `smoke-${tool.name}`, agent: { id: SESSION }, signal: new AbortController().signal }
      let value
      try {
        value = await tool.execute(args, exec)
      } catch (error) {
        failed += 1
        line(`── ${tool.name}: THREW ${error instanceof Error ? error.message : String(error)}`)
        continue
      }

      const snapshot = snapshotJsonValue(value)
      const violations = snapshot === undefined
        ? [`${tool.name} value is not lossless JSON`]
        : validateJsonSchemaValue(tool.output.schema, snapshot, 'value')
      const blocks = tool.output.render(args, value)
      const text = blocks
        .map(block => (block.type === 'text' ? block.text : block.type === 'image' ? `[image ${block.attachment.mediaType} ${block.attachment.bytes} bytes, ${block.attachment.width}x${block.attachment.height}]` : `[${block.type} block]`))
        .join('\n')

      const ok = violations.length === 0
      if (!ok) failed += 1
      line(`── ${tool.name} ${ok ? 'ok' : 'SCHEMA VIOLATION'}${violations.length ? ` ${violations.join('; ')}` : ''}`)
      for (const rendered of text.split('\n')) line(`   ${rendered}`)
      line()
    }

    const status = service.status(SESSION)
    line(`smoke: editor heartbeats=${status.editors[0]?.heartbeats} logsRetained=${status.logs?.retained} steps=${status.steps} locks=${status.locks}`)
  }

  // The screenshot the fake editor wrote is a real PNG: keep it where a human
  // can open it, and prove the bytes are the file, not a path.
  const shotDir = join(outDir, 'shots')
  try {
    const files = readFileSync(join(outDir, 'transcript.jsonl'), 'utf8')
    const methods = [...files.matchAll(/"method":"([^"]+)"/g)].map(match => match[1])
    line(`smoke: ${methods.length} frames exchanged; transcript -> ${join(outDir, 'transcript.jsonl')}`)
  } catch {
    // no transcript is not a failure
  }
  line(`smoke: screenshots and fixtures -> ${shotDir}`)
} catch (error) {
  failed += 1
  line(`smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
} finally {
  cleanup()
  await service.stop()
}

line()
line(failed === 0
  ? only
    ? `smoke: PASS — a fake editor answered ${only}`
    : 'smoke: PASS — every tool returned a schema-valid, rendered value from a fake editor'
  : `smoke: FAIL — ${failed} problem(s)`)
process.exit(failed === 0 ? 0 : 1)
