/**
 * The session-operations tools: the seven things a DSH session needs that a raw
 * protocol proxy cannot give it.
 *
 * Each exists because of a specific gap, not for symmetry:
 *
 * - `ual_screenshot` — UE returns a *file path*; this bridge is the place that can
 *   read it and turn it into an image block. Without it the model is told "PNG at
 *   K:\...\Saved\Screenshots\uespawn.png" and cannot look.
 * - `ual_logs` — the plugin has no log push by default (`ual.ForwardLogs` is a
 *   cvar only an editor-side human can set), so the bridge keeps its own ring and
 *   this reads it, with the pull commands as the fallback.
 * - `ual_undo` / `ual_undo_history` — UE keeps ONE agent undo buffer per editor,
 *   shared by every DSH session (see `sessions/state.ts`), so the per-session
 *   promise is only keepable in the LIFO case and must say so otherwise.
 * - `ual_locks` — `locks.set` is a whole-table replace, so the bridge owns the
 *   table and merges claims per session.
 * - `ual_task` — UAL has no async job API at all. `sequence.render`, `cpp.compile`,
 *   `level.build` and `pie.run` block the game thread for minutes with no progress
 *   endpoint reachable meanwhile. `ctx.jobs` gives a real id, a real wait, and real
 *   collection; cancelling stops *our* wait and says plainly that the engine keeps
 *   working.
 * - `ual_editor_bind` — several editors can dial in at once; a session needs to pin
 *   one so its calls do not drift between them.
 *
 * @module tools/operations
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JobHooks, JobOutcome, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

import type { UalService } from '../service.js'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonObject } from '../protocol/types.js'
import type { ScreenshotReader } from './screenshot.js'
import { readScreenshot } from './screenshot.js'
import { sessionOf, clip, brief, jsonable, VEC_SPEC } from './util.js'
import { translate } from '../errors/translate.js'

// Register this plugin's background kind with the generic job registry, the same
// declaration-merging shape `dsh-tool-terminal` uses. Without it `kind: 'ual'`
// is not a `JobKind` and the producer cannot start.
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'ual': 'ual'
  }
}

/** The kind name this plugin registers with `ctx.jobs`. */
export const UAL_JOB_KIND = 'ual'

/**
 * @param jobs - read lazily, because `ctx.jobs` is an *optional* composition: a
 * deployment without `dsh-jobs-local` gets the tool, and it says so honestly
 * rather than the plugin failing to load.
 */
export function makeOperationTools(
  service: UalService,
  screenshots: ScreenshotReader,
  jobs: () => JobRegistry | undefined,
): ToolDefinition[] {
  const ual_screenshot = defineTool({
    name: 'ual_screenshot',
    description:
      'Capture the Unreal Editor viewport (or the running game during PIE) and return the actual image so you can look at it, plus the capture facts. Use this instead of ual_call { method: "editor.screenshot" } whenever you need to SEE the level — the raw command only returns a file path. It reports pending_shaders / pending_assets: a nonzero count means the image is not the finished look, so do not conclude a material is broken from it.',
    parameters: {
      width: { type: 'integer', description: 'image width in px (default 1920)' },
      height: { type: 'integer', description: 'image height in px (default 1080)' },
      world: { type: 'string', enum: ['auto', 'editor'], description: 'auto follows PIE; "editor" forces the editor world even while PIE runs' },
      show_ui: { type: 'boolean', description: 'include the editor UI; falls back to HighResShot, which needs the window visible and can hang for a minute' },
      warmup_frames: { type: 'integer', description: 'extra frames rendered before capture (0-16) so exposure, Lumen and shadows converge' },
      actors: { type: 'array', items: { type: 'string' }, description: 'focus the viewport on these actor labels first, then shoot' },
      region: {
        type: 'object',
        additionalProperties: true,
        description: 'focus a world-space region instead of actors',
        properties: { min: VEC_SPEC, max: VEC_SPEC },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          path: { type: 'string', required: true },
          attached: { type: 'boolean', required: true },
          /**
           * The durable `ImageAttachmentRef` the `image` render block carries.
           *
           * It must be declared even though the model never reads it: the registry
           * validates every canonical value against this schema with
           * `additionalProperties: false`, and an undeclared key makes the whole
           * tool call throw `ToolOutputError` — the model would get "output
           * invalid" instead of the screenshot it asked to see.
           */
          attachment: { type: 'json' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          world: { type: 'string' },
          view: { type: 'string' },
          pendingShaders: { type: 'integer' },
          pendingAssets: { type: 'integer' },
          streamingInFlight: { type: 'integer' },
          exposure: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as Record<string, JsonValue>
        if (record.ok !== true) {
          return [{ type: 'text', text: `screenshot failed: ${record.error ?? 'unknown'}\n  do this: ${record.hint ?? 'check ual_status for a connected editor'}` }]
        }
        const lines = [`screenshot ${record.attached ? 'attached' : 'captured (not attached)'}: ${record.path}`]
        if (record.world) lines.push(`  world=${record.world}${record.view ? ` view=${record.view}` : ''}`)
        if (record.pendingShaders) lines.push(`  ${record.pendingShaders} shader(s) still compiling — the image is not the finished look`)
        if (record.note) lines.push(`  ${record.note}`)
        // The image block is what the model reads; Native mode drops non-text
        // blocks, so the file path above is the guaranteed fallback.
        const blocks = [{ type: 'text' as const, text: lines.join('\n') }]
        // `attachment` is declared `type: 'json'` in the output schema, so the
        // inferred value type is JsonValue while `ImageBlock.attachment` wants an
        // `ImageAttachmentRef`. The ref is put there verbatim by this tool's own
        // execute, and this guard proves it before the block is built — a cast
        // would let a malformed ref reach the model as a broken image block.
        const attachment = imageRef(record.attachment)
        return attachment ? [{ type: 'image', attachment }, ...blocks] : blocks
      },
      presentationMeta: (_args, value) => {
        const record = value as Record<string, JsonValue>
        return { path: record.path, attached: record.attached, width: record.width, height: record.height }
      },
    },
    // One capture is a SceneCapture plus warmup frames on the game thread.
    timeoutMs: 150_000,
    presentCall: () => ({ card: 'generic', title: 'screenshot Unreal viewport', kind: 'search' }),
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const method = args.show_ui === true ? 'editor.capture_app_window' : 'editor.screenshot'
      const params: Record<string, unknown> = {}
      if (args.width !== undefined || args.height !== undefined) params.resolution = [args.width ?? 1920, args.height ?? 1080]
      if (args.world === 'editor') params.world = 'editor'
      if (args.warmup_frames !== undefined) params.warmup_frames = args.warmup_frames
      if (args.show_ui === true) params.show_ui = true

      // Focus first: a screenshot of wherever the camera happens to be is usually
      // not what "look at the level" means, and viewport.focus is cheap.
      if (args.actors?.length || args.region) {
        const focus = await service.call({
          method: 'viewport.focus',
          params: args.region ? { region: args.region } : { targets: { names: args.actors } },
          session,
          signal: exec.signal,
        })
        if (!focus.value.ok) {
          return {
            ok: false,
            path: '',
            attached: false,
            error: focus.value.error,
            hint: `could not frame the shot: ${focus.value.hint ?? 'see ual_schema for viewport.focus'}`,
          }
        }
      }

      const outcome = await service.call({ method, params, session, signal: exec.signal, timeoutMs: 150_000, noCache: true })
      if (!outcome.value.ok) {
        return {
          ok: false,
          path: '',
          attached: false,
          ...(outcome.translated ? { error: outcome.translated.error, hint: outcome.translated.hint } : {}),
        }
      }

      const shot = readScreenshot(outcome.value.result)
      if (!shot) {
        return {
          ok: false,
          path: '',
          attached: false,
          error: 'the capture command returned no file path',
          hint: 'the editor answered without saved:true + path — check ual_logs for the capture error',
        }
      }

      const attached = await screenshots.attach(shot, exec.signal)
      // The ref is pulled back out of the render block rather than returned
      // alongside it, so there is exactly one place that decides what the image
      // is. It is only surfaced in the canonical value because the output schema
      // must declare every key the registry will validate.
      const image = attached.blocks.find(block => block.type === 'image') as { attachment: JsonValue } | undefined
      return {
        ok: true,
        path: shot.path,
        attached: attached.attached,
        ...(image ? { attachment: image.attachment } : {}),
        ...(shot.width !== undefined ? { width: shot.width } : {}),
        ...(shot.height !== undefined ? { height: shot.height } : {}),
        ...(shot.world !== undefined ? { world: shot.world } : {}),
        ...(shot.view !== undefined ? { view: shot.view } : {}),
        ...(shot.pendingShaders !== undefined ? { pendingShaders: shot.pendingShaders } : {}),
        ...(shot.pendingAssets !== undefined ? { pendingAssets: shot.pendingAssets } : {}),
        ...(shot.exposure !== undefined ? { exposure: shot.exposure } : {}),
        ...(attached.reason ? { note: attached.reason } : {}),
      }
    },
  })

  const ual_logs = defineTool({
    name: 'ual_logs',
    description:
      'Read Unreal Engine log lines this bridge has captured, filtered by level, category, or a substring. Use it after a command fails, after a compile, or after PIE to see what the engine actually said. If it comes back empty, UE log forwarding is off: the cvar ual.ForwardLogs must be set to 1 inside the editor (or -ual.ForwardLogs=1 at launch); while it is off, use ual_call { method: "messagelog.list" } instead, which is the engine Message Log and needs no cvar.',
    parameters: {
      level: { type: 'string', enum: ['Fatal', 'Error', 'Warning', 'Display', 'Log', 'Verbose'], description: 'this level and above in severity' },
      category: { type: 'string', description: 'substring of the log category, e.g. "LogBlueprint"' },
      contains: { type: 'string', description: 'substring of the message' },
      sinceSeq: { type: 'integer', description: 'only lines newer than this seq (the last seq you already read)' },
      limit: { type: 'integer', description: 'most recent N lines, newest last (default 40, max 200)' },
      pullMessageLog: { type: 'boolean', description: 'instead of this bridge\u2019s ring, read the engine Message Log: with category given it returns that category\u2019s lines, otherwise the list of categories that currently have one' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'integer', required: true },
          lastSeq: { type: 'integer', required: true },
          entries: { type: 'array', items: { type: 'json' }, required: true },
          source: { type: 'string', description: 'ring (this bridge captured the lines), message-log-categories, or message-log-lines (pulled from the engine Message Log)' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as { count: number; lastSeq: number; entries: JsonValue[]; source?: string; hint?: string }
        if (record.count === 0) {
          return [{ type: 'text', text: `no matching UE log lines (ring holds ${record.lastSeq} total).\n  ${record.hint ?? ''}` }]
        }
        const lines = record.source === 'message-log-categories'
          ? [`${record.count} engine Message Log categor${record.count === 1 ? 'y' : 'ies'}:`]
          : [`${record.count} UE log line(s)${record.source === 'message-log-lines' ? ' from the engine Message Log' : ''}, newest last, lastSeq=${record.lastSeq}`]
        for (const raw of record.entries) {
          const entry = raw as { level?: string; category?: string; text?: string }
          lines.push(`  ${entry.level ?? ''} ${entry.category ?? ''}: ${String(entry.text ?? '').slice(0, 400)}`)
        }
        if (record.source === 'message-log-categories' && record.hint) lines.push(`  ${record.hint}`)
        return [{ type: 'text', text: clip(lines.join('\n'), 20_000) }]
      },
      presentationMeta: (_args, value) => {
        const record = value as { count: number; lastSeq: number }
        return { count: record.count, lastSeq: record.lastSeq }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      if (args.pullMessageLog === true) {
        // `messagelog.list` takes NO parameters and answers with the Message Log's
        // *category tree* (`categories: [{name, label}]`); the lines live behind
        // `messagelog.get`, which needs one category name. Asking `list` for lines
        // — which this branch used to do, sending a `limit` the handler ignores and
        // wrapping the category payload as a single "log line" — rendered exactly
        // one blank row, whatever the editor had to say.
        if (args.category !== undefined && args.category.length > 0) {
          const outcome = await service.call({ method: 'messagelog.get', params: { category: args.category }, session, signal: exec.signal })
          if (!outcome.value.ok) {
            return { ok: false, count: 0, lastSeq: service.latestLogSeq(), entries: [], source: 'message-log-lines', ...(outcome.translated ? { hint: outcome.translated.hint } : {}) }
          }
          const result = (outcome.value.result ?? {}) as JsonObject
          const messages = Array.isArray(result.messages) ? result.messages : []
          const limit = args.limit ?? 40
          const shown = messages.slice(Math.max(0, messages.length - limit))
          return {
            ok: true,
            count: shown.length,
            lastSeq: service.latestLogSeq(),
            source: 'message-log-lines',
            // Uniform entry shape: the engine sends `{severity, text, tokens}`, the
            // ring sends `{level, category, text}`, and the render reads one shape.
            entries: shown.map(message => {
              const entry = (typeof message === 'object' && message !== null ? message : {}) as Record<string, JsonValue>
              return jsonable({
                level: typeof entry.severity === 'string' ? entry.severity : 'Unknown',
                category: args.category,
                text: typeof entry.text === 'string' ? entry.text : '',
              })
            }),
          }
        }
        const outcome = await service.call({ method: 'messagelog.list', params: {}, session, signal: exec.signal })
        if (!outcome.value.ok) {
          return { ok: false, count: 0, lastSeq: 0, entries: [], source: 'message-log-categories', ...(outcome.translated ? { hint: outcome.translated.hint } : {}) }
        }
        const result = (outcome.value.result ?? {}) as JsonObject
        const categories = Array.isArray(result.categories) ? result.categories : []
        return {
          ok: true,
          count: categories.length,
          lastSeq: service.latestLogSeq(),
          source: 'message-log-categories',
          entries: categories.map(category => {
            const entry = (typeof category === 'object' && category !== null ? category : {}) as Record<string, JsonValue>
            return jsonable({
              level: 'MessageLog',
              category: typeof entry.name === 'string' ? entry.name : '',
              text: typeof entry.label === 'string' ? entry.label : '',
            })
          }),
          hint: 'these are the categories the engine Message Log is holding, not their lines: pass category to read the lines inside one',
        }
      }
      const entries = service.logs({
        ...(args.level ? { level: args.level } : {}),
        ...(args.category ? { category: args.category } : {}),
        ...(args.contains ? { contains: args.contains } : {}),
        ...(args.sinceSeq !== undefined ? { sinceSeq: args.sinceSeq } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      })
      // `jsonable` drops the optional `project` on log lines that arrived before
      // the editor identified itself: a `null`-vs-absent distinction the model
      // does not need, and `undefined` is not canonical JSON.
      return {
        ok: true,
        count: entries.length,
        lastSeq: service.latestLogSeq(),
        source: 'ring',
        entries: entries.map(entry => jsonable({ seq: entry.seq, at: entry.at, level: entry.level, category: entry.category, text: entry.text, project: entry.project })),
        ...(entries.length === 0 && !service.config.logForwardingEnabled
          ? { hint: 'UE is not forwarding logs: this bridge only sees what the editor pushes. Set the console variable ual.ForwardLogs to 1 inside Unreal Editor, or pass pullMessageLog:true to read the engine Message Log instead.' }
          : {}),
      }
    },
  })

  const ual_undo = defineTool({
    name: 'ual_undo',
    description:
      'Roll back what THIS DSH session did in the editor. UnrealAgentLink keeps its own undo buffer per editor, separate from the user\u2019s Ctrl+Z history, and this bridge records which steps came from which session. The rollback is only exact when this session\u2019s steps are the most recent ones on that buffer; if another session acted after you, nothing is undone and the tool reports both step lists instead of silently undoing someone else\u2019s work. Read the affected_packages / affected_objects it returns — they are what to check afterwards.',
    parameters: {
      steps: { type: 'integer', description: 'how many of this session\u2019s steps to undo (default: all of them, newest first)' },
      dryRun: { type: 'boolean', description: 'report what would be undone without undoing it' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          undone: { type: 'integer', required: true },
          dryRun: { type: 'boolean' },
          stepsRemaining: { type: 'integer' },
          titles: { type: 'array', items: { type: 'string' } },
          affectedPackages: { type: 'array', items: { type: 'string' } },
          affectedObjects: { type: 'array', items: { type: 'string' } },
          refused: { type: 'string' },
          sessionSteps: { type: 'array', items: { type: 'json' } },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as Record<string, JsonValue>
        if (record.refused) return [{ type: 'text', text: `NOT ROLLED BACK: ${record.refused}\n  this session\u2019s steps: ${brief(record.sessionSteps ?? [], 900)}` }]
        if (record.ok !== true) return [{ type: 'text', text: `undo failed: ${record.error}\n  do this: ${record.hint ?? ''}` }]
        const lines = [`${String(record.undone)} step(s) ${record.dryRun ? 'would be undone' : 'undone'}`]
        for (const title of (record.titles ?? []) as string[]) lines.push(`  - ${title}`)
        const packages = (record.affectedPackages ?? []) as string[]
        if (packages.length) lines.push(`  packages touched: ${packages.slice(0, 20).join(', ')}${packages.length > 20 ? ` (+${packages.length - 20} more)` : ''}`)
        const objects = (record.affectedObjects ?? []) as string[]
        if (objects.length) lines.push(`  objects: ${objects.slice(0, 20).join(', ')}${objects.length > 20 ? ` (+${objects.length - 20} more)` : ''}`)
        lines.push(`  session steps remaining: ${record.stepsRemaining}`)
        lines.push('  NOTE: a save is not undone by this, and unsaved changes stay dirty in the editor.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const mine = service.sessions.steps(session)
      if (mine === 0) {
        return { ok: true, undone: 0, stepsRemaining: 0, titles: [], affectedPackages: [], affectedObjects: [], hint: 'this session has recorded no editor mutations' }
      }
      if (!service.sessions.canRollbackLifo(session)) {
        const state = service.sessions.state(session)
        return {
          ok: false,
          undone: 0,
          stepsRemaining: mine,
          refused:
            'another DSH session acted in this editor after you, so undoing your steps would also undo theirs. Nothing was changed.',
          sessionSteps: state.ledger.map(entry => ({ step: entry.step, method: entry.method, packages: entry.packages.slice(0, 5) })),
          hint: 'Ask the user to undo in the editor, or wait until the other session finishes. To roll back only your last action when it is the newest, retry with steps:1.',
        }
      }
      const requested = args.steps ?? mine
      // Never undo more than this session's share, even if asked: the buffer is
      // shared, and "steps: 50" must not eat another session's work.
      const steps = Math.max(1, Math.min(requested, mine))

      if (args.dryRun === true) {
        const history = await service.call({ method: 'editor.undo_history', params: { limit: steps }, session, signal: exec.signal, noCache: true })
        const entries = (history.value.result as { entries?: { title: string }[] })?.entries ?? []
        return {
          ok: true,
          undone: steps,
          dryRun: true,
          stepsRemaining: mine - steps,
          titles: entries.map(entry => entry.title),
          affectedPackages: [],
          affectedObjects: [],
        }
      }

      const outcome = await service.call({ method: 'editor.undo', params: { steps }, session, signal: exec.signal, noCache: true })
      if (!outcome.value.ok) return { ok: false, undone: 0, stepsRemaining: mine, ...(outcome.translated ? { error: outcome.translated.error, hint: outcome.translated.hint } : {}) }

      const result = (outcome.value.result ?? {}) as JsonObject
      const strings = (value: JsonValue | undefined): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
      const titles = strings(result.step_titles)
      const packages = strings(result.affected_packages)
      const objects = strings(result.affected_objects)
      // Only forget the steps we actually removed, and only when the engine said
      // the count matched — a partial undo must keep the rest in the ledger.
      const applied = typeof result.steps_applied === 'number' ? result.steps_applied : titles.length
      if (applied >= steps) service.sessions.clearLedger(session)
      else {
        const state = service.sessions.state(session)
        state.ledger = state.ledger.slice(0, Math.max(0, state.ledger.length - applied))
      }
      service.sessions.invalidate(session)
      return {
        ok: result.error === undefined,
        undone: applied,
        stepsRemaining: service.sessions.steps(session),
        titles,
        affectedPackages: packages,
        affectedObjects: objects,
        ...(typeof result.error === 'string' ? { error: result.error } : {}),
      }
    },
  })

  const ual_undo_history = defineTool({
    name: 'ual_undo_history',
    description: 'List the steps currently on the agent undo buffer for the bound editor, newest last, with the packages and objects each one touched. Read this before ual_undo so you know what a rollback would remove.',
    parameters: { limit: { type: 'integer', description: 'most recent N steps (default 20)' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, undoable: { type: 'integer' }, redoable: { type: 'integer' }, entries: { type: 'array', items: { type: 'json' } }, hint: { type: 'string' }, error: { type: 'string' } } },
      render: (_args, value) => {
        const record = value as { ok: boolean; undoable?: number; redoable?: number; entries?: JsonValue[]; error?: string; hint?: string }
        if (!record.ok) return [{ type: 'text', text: `undo history failed: ${record.error}\n  ${record.hint ?? ''}` }]
        const lines = [`${record.undoable} undoable step(s), ${record.redoable} redoable on the agent buffer`]
        for (const entry of record.entries ?? []) lines.push(`  ${brief(entry, 300)}`)
        lines.push('  these are this plugin\u2019s steps only; the user\u2019s own Ctrl+Z history is a separate buffer')
        return [{ type: 'text', text: clip(lines.join('\n'), 16_000) }]
      },
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const outcome = await service.call({ method: 'editor.undo_history', params: { limit: args.limit ?? 20 }, session, signal: exec.signal })
      if (!outcome.value.ok) {
        return { ok: false, ...(outcome.translated ? { error: outcome.translated.error, hint: outcome.translated.hint } : {}) }
      }
      const result = (outcome.value.result ?? {}) as JsonObject
      const count = (value: JsonValue | undefined): number | undefined =>
        typeof value === 'number' ? value : undefined
      return {
        ok: true,
        undoable: count(result.undoable) ?? 0,
        redoable: count(result.redoable) ?? 0,
        entries: Array.isArray(result.entries) ? result.entries : [],
        hint: 'a level switch clears this buffer, so steps recorded before one are not undoable even if listed here',
      }
    },
  })

  const ual_locks = defineTool({
    name: 'ual_locks',
    description:
      'Declare which asset paths this session is working on, so the editor draws "AI is editing" badges in the Content Browser and warns the user before they hand-edit one. The bridge merges every live session\u2019s claims into the single table UE keeps, and re-pushes it after a reconnect. Claim locks before a multi-step asset edit; release them when done. The read-only enforcement flag is deliberately not offered here: it sets the file permission bit and UE\u2019s Save All then skips those packages silently, which loses a user\u2019s work.',
    parameters: {
      claim: { type: 'array', items: { type: 'string' }, description: 'package paths to claim, e.g. ["/Game/Props/SM_Chair"]' },
      release: { type: 'array', items: { type: 'string' }, description: 'package paths to release' },
      level: { type: 'boolean', description: 'also flag the current level as being edited by an agent' },
      clear: { type: 'boolean', description: 'release everything this session claims' },
      list: { type: 'boolean', description: 'just report the merged table' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          mine: { type: 'array', items: { type: 'string' }, required: true },
          merged: { type: 'array', items: { type: 'string' }, required: true },
          pushed: { type: 'boolean' },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as { ok: boolean; mine: string[]; merged: string[]; pushed?: boolean; error?: string; hint?: string }
        if (!record.ok) return [{ type: 'text', text: `locks failed: ${record.error}\n  ${record.hint ?? ''}` }]
        const lines = [
          `this session claims ${record.mine.length} asset path(s): ${record.mine.slice(0, 12).join(', ')}${record.mine.length > 12 ? ` (+${record.mine.length - 12})` : ''}`,
          `pushed to the editor as the whole table (${record.merged.length} path(s))${record.pushed === false ? ', NOT confirmed — no editor connected' : ''}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => value,
    },
    timeoutMs: 30_000,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const state = service.sessions.state(session)
      if (args.clear === true) {
        service.clearLocks(session)
        return { ok: true, mine: [], merged: service.sessions.mergedLocks(), pushed: await service.pushLocksNow() }
      }
      if (args.list === true && !args.claim?.length && !args.release?.length) {
        return { ok: true, mine: [...state.locks].sort(), merged: service.sessions.mergedLocks(), pushed: service.locksPushed() }
      }
      service.setLocks(session, args.claim ?? [], args.release ?? [])
      let pushed: boolean
      if (args.level !== undefined) {
        // level_locked is a soft badge only; the plugin never enforces it. This
        // sends the whole table itself rather than going through maybePushLocks,
        // so the outcome is known directly. `service.call` reports failures in the
        // returned value rather than by throwing.
        const outcome = await service.call({ method: 'locks.set', params: { paths: service.sessions.mergedLocks(), level_locked: args.level }, session, signal: exec.signal, long: true, noCache: true })
        pushed = outcome.value.ok
      } else {
        pushed = await service.pushLocksNow()
      }
      return { ok: true, mine: [...state.locks].sort(), merged: service.sessions.mergedLocks(), pushed }
    },
  })

  const ual_editor_bind = defineTool({
    name: 'ual_editor_bind',
    description:
      'Choose which connected Unreal Editor THIS session talks to. Several editors can dial into the bridge at once; without a binding the session follows the single connected editor, and an ambiguous multi-editor call fails rather than guessing. Use it to pin a project, and with clear:true to go back to following whichever editor is connected. The binding makes cached reads and the undo ledger unambiguous per session.',
    parameters: {
      editor: { type: 'string', description: 'a session id or project name from ual_status' },
      pin: { type: 'boolean', description: 'keep this binding for the whole session (default true when editor is given)' },
      clear: { type: 'boolean', description: 'drop the binding' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          bound: { type: 'string' },
          editors: { type: 'array', items: { type: 'json' } },
          error: { type: 'string' },
          hint: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const record = value as { ok: boolean; bound?: string; editors?: JsonValue[]; error?: string; hint?: string }
        if (!record.ok) {
          const connected = (record.editors ?? []).map(entry => {
            const item = entry as { project?: string; sessionId?: string }
            return item.project ?? item.sessionId ?? '?'
          }).join(', ')
          return [{ type: 'text', text: `bind failed: ${record.error}\n  connected: ${connected || 'none'}\n  ${record.hint ?? ''}` }]
        }
        const lines = [record.bound ? `this session is bound to ${record.bound}` : 'binding cleared; this session follows whichever single editor is connected']
        for (const editor of record.editors ?? []) lines.push(`  ${brief(editor, 260)}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
      presentationMeta: (_args, value) => value,
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      if (args.clear === true) {
        const result = service.bind(session, undefined, false)
        return { ok: true, editors: result.editors }
      }
      if (!args.editor) return { ok: false, error: 'give editor, or clear:true', hint: 'ual_status lists the connected editors' }
      const result = service.bind(session, args.editor, args.pin !== false)
      if (!result.ok) return { ok: false, error: result.error, editors: result.editors, hint: 'pass a sessionId or project name exactly as ual_status reports it' }
      const state = service.sessions.state(session)
      return { ok: true, ...(state.editor ? { bound: state.editor } : {}), editors: result.editors }
    },
  })

  const ual_task = defineTool({
    name: 'ual_task',
    description:
      'Run one long UnrealAgentLink command as a background DSH job and return its job id immediately, so the conversation continues while the engine works. Required for anything that blocks the editor\u2019s game thread: sequence.render, cpp.compile, level.build, blueprint.compile_all, pcg.execute, pie.run, an asset import. Use job_output / job_list / job_kill to collect it. IMPORTANT: UnrealAgentLink has no cancellation — killing the job only stops us waiting; the engine keeps running the command and its result still lands. And while a blocking command runs, the editor answers NOTHING, so do not poll it with other commands.',
    parameters: {
      method: { type: 'string', required: true, description: 'the UAL command, e.g. "sequence.render"' },
      params: { type: 'object', additionalProperties: true },
      label: { type: 'string', description: 'one line for the job list; defaults to the method' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'background' },
          jobId: { type: 'string', required: true },
          method: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const record = value as { jobId: string; method: string; note: string }
        return [{ type: 'text', text: `started background editor task ${record.jobId} (${record.method})\n  ${record.note}` }]
      },
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const { session } = sessionOf(exec)
      const registry = jobs()
      if (!registry) {
        return {
          kind: 'background' as const,
          jobId: '',
          method: args.method,
          note: 'UNAVAILABLE: this DSH composition loads no job registry (dsh-jobs-local + dsh-tool-jobs). Run it with ual_call and give it a large timeoutMs instead.',
        }
      }
      // The job runs the same guarded path, but detached from this tool call.
      const controller = new AbortController()
      let cancelRequested = false
      const jobId = registry.start({
        kind: UAL_JOB_KIND,
        label: args.label ?? `${args.method} (Unreal Editor)`,
        ...(exec.agent ? { owner: exec.agent } : {}),
        outputLimitBytes: 64 * 1024,
        run: (): JobHooks => {
          const settled: Promise<JobOutcome> = service
            .call({
              method: args.method,
              ...(args.params !== undefined ? { params: args.params as Record<string, unknown> } : {}),
              ...(exec.agent ? { agent: exec.agent } : {}),
              session,
              long: true,
              signal: controller.signal,
              // A task owns its own lifetime; the configured blocking floor is
              // what applies, not the caller's tool timeout.
            })
            .then(
              outcome =>
                outcome.value.ok
                  ? { status: 'completed' as const, detail: `${args.method} ok`, output: clip(JSON.stringify(outcome.value.result ?? {}), 60_000) ?? '{}' }
                  : {
                      status: 'failed' as const,
                      detail: outcome.value.error ?? 'failed',
                      output: JSON.stringify({ error: outcome.value.error, hint: outcome.value.hint, details: outcome.value.details }),
                    },
              error => {
                const translated = translate(error, args.method)
                return { status: 'failed' as const, detail: translated.error, output: JSON.stringify({ error: translated.error, hint: translated.hint }) }
              },
            )
          return {
            // Cancelling stops the wait, not the engine: UAL has no cancel. The
            // promise still settles and the record still closes.
            cancel: () => {
              cancelRequested = true
              controller.abort(new Error('job killed from DSH'))
            },
            done: settled.then(outcome => (cancelRequested ? { ...outcome, detail: `${outcome.detail ?? ''} [kill requested; the editor cannot be cancelled, so this command may still have completed]` } : outcome)),
            readOutput: () => (cancelRequested ? 'cancel requested — the editor is still running the command and cannot be interrupted' : ''),
          }
        },
      })
      return {
        kind: 'background' as const,
        jobId,
        method: args.method,
        note: `while it runs the editor answers no other command (its game thread is busy) — collect the result with job_output, do not poll with ual_call`,
      }
    },
  })

  return [ual_screenshot, ual_logs, ual_undo, ual_undo_history, ual_locks, ual_editor_bind, ual_task]
}

/**
 * Narrow a schema-`json` attachment value back to the `ImageAttachmentRef` an
 * `image` block needs, by checking the fields rather than asserting the type.
 *
 * The output schema has to declare `attachment: { type: 'json' }`, because the
 * schema language has no `ImageAttachmentRef` node and the registry validates
 * every key with `additionalProperties: false`. That widens the inferred value to
 * `JsonValue`, so the render block cannot take it directly. A cast would compile
 * and then hand the model an image block built from whatever happened to be there;
 * this returns undefined instead, and the render falls back to the text block that
 * already names the file path.
 */
function imageRef(value: unknown): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.attachmentId !== 'string') return undefined
  if (record.mediaType !== 'image/png' && record.mediaType !== 'image/jpeg' && record.mediaType !== 'image/webp' && record.mediaType !== 'image/gif') return undefined
  for (const key of ['bytes', 'width', 'height'] as const) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key])) return undefined
  }
  return {
    attachmentId: record.attachmentId,
    mediaType: record.mediaType,
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  } as ImageAttachmentRef
}
