/**
 * Getting an image from the editor into the model's context.
 *
 * ## Why this needs a module of its own
 *
 * `editor.screenshot` answers with a **file path**, not bytes — the plugin writes
 * a PNG under the project's Saved dir and returns `path`/`filename`. Its own
 * Chinese doc claims a base64 `image` field, and the C++ contains no base64 in the
 * capture path at all, so the file on disk is the only handle we get. UE and this
 * bridge are on the same machine (UE dials 127.0.0.1), which is what makes reading
 * that path legitimate rather than a sandbox escape.
 *
 * ## DSH, not fs.readFileSync
 *
 * The bytes go through `ctx.fs` so a remote/SSH-mounted harness reads the right
 * filesystem, and through `ctx.attachments` so the image is durably stored,
 * content-addressed, and replayable — a raw base64 block in a tool result would
 * bloat every later request and vanish on compaction.
 *
 * Both services are read with `ctx.get`, because a composition without them is a
 * valid deployment: the tool then returns the path and says so, instead of the
 * plugin failing to load.
 *
 * @module tools/screenshot
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

import { mediaTypeOf } from './util.js'

export interface ScreenshotFact {
  path: string
  filename?: string
  width?: number
  height?: number
  /** Nonzero means the picture is not the finished look — report, never swallow. */
  pendingShaders?: number
  pendingAssets?: number
  streamingInFlight?: number
  world?: string
  view?: string
  method?: string
  cameraSource?: string
  exposure?: string
}

export interface AttachResult {
  blocks: ContentBlock[]
  attached: boolean
  /** Why an image could not be attached, when it could not. */
  reason?: string
}

/** Read a screenshot result body into the facts we surface. */
export function readScreenshot(result: unknown): ScreenshotFact | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const record = result as Record<string, unknown>
  if (record.saved !== true || typeof record.path !== 'string') return undefined
  const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    path: record.path,
    ...(typeof record.filename === 'string' ? { filename: record.filename } : {}),
    ...(num(record.width) !== undefined ? { width: num(record.width) } : {}),
    ...(num(record.height) !== undefined ? { height: num(record.height) } : {}),
    ...(num(record.pending_shaders) !== undefined ? { pendingShaders: num(record.pending_shaders) } : {}),
    ...(num(record.pending_assets) !== undefined ? { pendingAssets: num(record.pending_assets) } : {}),
    ...(num(record.streaming_in_flight) !== undefined ? { streamingInFlight: num(record.streaming_in_flight) } : {}),
    ...(typeof record.world === 'string' ? { world: record.world } : {}),
    ...(typeof record.view === 'string' ? { view: record.view } : {}),
    ...(typeof record.method === 'string' ? { method: record.method } : {}),
    ...(typeof record.camera_source === 'string' ? { cameraSource: record.camera_source } : {}),
    ...(typeof record.exposure === 'string' ? { exposure: record.exposure } : {}),
  }
}

/**
 * The compile-time-free face of `ctx.fs` / `ctx.attachments`.
 *
 * These services are optional in the composition, so they are read with `ctx.get`
 * and their methods are reached through a narrow local interface. The type names
 * differ across dsh-fs releases (`readBytes` gained a `maxBytes` argument; some
 * builds use `readBinary`), so the shim tries each in turn — a mismatch must
 * degrade to "here is the path", never to a thrown TypeError inside a tool.
 */
interface FsLike {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<{ targetKey: string; displayPath: string }>
  stat(target: unknown, signal?: AbortSignal): Promise<{ type: string; size?: number } | undefined>
  readBytes?: (target: unknown, signal: AbortSignal | undefined, maxBytes: number) => Promise<Uint8Array>
  readBinary?: (target: unknown, signal?: AbortSignal, maxBytes?: number) => Promise<Uint8Array>
}

interface AttachmentsLike {
  saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name?: string }): Promise<ImageAttachmentRef>
}

export class ScreenshotReader {
  constructor(
    private readonly ctx: Context,
    private readonly options: { maxBytes: number; enabled: boolean },
  ) {}

  /**
   * @param signal - the tool call's signal, so a cancelled turn stops reading.
   */
  async attach(screenshot: ScreenshotFact, signal: AbortSignal): Promise<AttachResult> {
    const facts = describe(screenshot)
    if (!this.options.enabled) {
      return { attached: false, blocks: [{ type: 'text', text: `Screenshot saved.\n${facts}` }], reason: 'screenshotAttachments is disabled in this plugin\u2019s config' }
    }
    const fs = this.ctx.get('fs') as FsLike | undefined
    const attachments = this.ctx.get('attachments') as AttachmentsLike | undefined
    if (!fs || !attachments) {
      return {
        attached: false,
        blocks: [{ type: 'text', text: `Screenshot saved to a file, but this DSH composition provides no fs/attachments service, so it cannot be shown.\n${facts}` }],
        reason: 'ctx.fs or ctx.attachments is not composed',
      }
    }

    const mediaType = mediaTypeOf(screenshot.path)
    if (!mediaType) {
      return { attached: false, blocks: [{ type: 'text', text: `Screenshot saved.\n${facts}` }], reason: `not a recognized image extension: ${screenshot.path}` }
    }

    try {
      const target = await fs.resolve(screenshot.path, { signal })
      const info = await fs.stat(target, signal)
      if (!info) return { attached: false, blocks: [{ type: 'text', text: `Screenshot result named a path that does not exist.\n${facts}` }], reason: `no such file: ${screenshot.path}` }
      if (info.type !== 'file') {
        return { attached: false, blocks: [{ type: 'text', text: `Screenshot path is not a regular file.\n${facts}` }], reason: `${screenshot.path} is a ${info.type}` }
      }
      // Cap before reading, not after: a 4K screenshot from a stale run is still
      // bytes we would have to base64 into a prompt.
      const cap = Math.max(this.options.maxBytes, 64 * 1024)
      if (typeof info.size === 'number' && info.size > cap) {
        return {
          attached: false,
          blocks: [{ type: 'text', text: `Screenshot is ${info.size} bytes, over the plugin's screenshotMaxBytes.\n${facts}` }],
          reason: `file is ${info.size} bytes; raise screenshotMaxBytes to attach it`,
        }
      }

      const data = await this.readBytes(fs, target, signal, cap)
      if (!data || data.byteLength === 0) {
        return { attached: false, blocks: [{ type: 'text', text: `Screenshot file could not be read.\n${facts}` }], reason: 'readBytes returned nothing' }
      }
      const ref = await attachments.saveImage({ data, mediaType, name: screenshot.filename ?? 'screenshot' })
      // No cast: `ImageBlock.attachment` and `attachments.saveImage`'s return are
      // structurally the same `ImageAttachmentRef`, so the compiler checks this.
      // It used to be `as unknown as ContentBlock`, which would have accepted a
      // ref missing a required field — `snapshotJsonValue` on the tool result is
      // what actually rejects such a block, and only at runtime.
      return { attached: true, blocks: [{ type: 'image', attachment: ref }] }
    } catch (error) {
      // A read failure must still deliver the facts: the pending_shaders counts
      // are the whole point of the call even when the pixels never arrive.
      return {
        attached: false,
        blocks: [{ type: 'text', text: `Screenshot was captured but could not be attached.\n${facts}` }],
        reason: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** `readBytes(target, signal, maxBytes)` in current dsh-fs; older shapes otherwise. */
  private async readBytes(fs: FsLike, target: unknown, signal: AbortSignal, cap: number): Promise<Uint8Array | undefined> {
    // An over-cap read is a real answer, not a bug to paper over, so nothing is
    // caught here: the caller turns the thrown message into the `reason` the model
    // sees, and the facts still travel.
    if (typeof fs.readBytes === 'function') return await fs.readBytes(target, signal, cap)
    if (typeof fs.readBinary === 'function') return fs.readBinary(target, signal, cap)
    throw new TypeError('ctx.fs exposes neither readBytes nor readBinary — this build of dsh-fs is not supported for screenshots')
  }
}

/**
 * The facts that travel with every screenshot, attached or not.
 *
 * `pending_shaders > 0` is stated in plain words because the model cannot tell a
 * material that is broken from a material that has not compiled yet by looking at
 * a picture — upstream's own DEVELOPING.md says exactly this, and refuses to let
 * the box side swallow the counts.
 */
function describe(screenshot: ScreenshotFact): string {
  const lines = [`  file: ${screenshot.path}`]
  if (screenshot.width && screenshot.height) lines.push(`  size: ${screenshot.width}x${screenshot.height}`)
  if (screenshot.world) lines.push(`  world: ${screenshot.world}${screenshot.view ? ` (view: ${screenshot.view})` : ''}`)
  if (screenshot.method) lines.push(`  captured by: ${screenshot.method}`)
  if (screenshot.cameraSource) lines.push(`  camera: ${screenshot.cameraSource}`)
  if (screenshot.exposure) lines.push(`  exposure: ${screenshot.exposure} — do not judge brightness from this image`)
  const pending = [
    screenshot.pendingShaders ? `${screenshot.pendingShaders} shaders` : undefined,
    screenshot.pendingAssets ? `${screenshot.pendingAssets} assets` : undefined,
    screenshot.streamingInFlight ? `${screenshot.streamingInFlight} streaming requests` : undefined,
  ].filter(Boolean)
  if (pending.length > 0) {
    lines.push(`  NOT FINAL: still compiling ${pending.join(', ')} — the image may show grey/checkered materials. Re-shoot later or wait.`)
  }
  return lines.join('\n')
}
