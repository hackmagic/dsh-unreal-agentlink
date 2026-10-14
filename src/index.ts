/**
 * dsh-unreal-agentlink — a DSH plugin bridging the UnrealAgentLink (UEBox)
 * editor protocol.
 *
 * ## What this file decides
 *
 * It is the only place that touches the Cordis lifecycle: build one service per
 * plugin fiber, mount the tools, install the approval gate, and unwind all of it
 * on dispose. Everything else is in modules that take plain objects.
 *
 * ## The shape of the tool surface, and why it is 12 tools not 170
 *
 * The plugin exposes ~12 tools, not one per UAL method:
 *
 * - `ual_status`, `ual_tools`, `ual_schema`, `ual_call`, `ual_batch` — discovery
 *   and execution for all 170 commands (~2k prompt tokens total, versus roughly
 *   170 schemas the model would re-read every request).
 * - `ual_screenshot`, `ual_logs`, `ual_undo`, `ual_undo_history`, `ual_locks`,
 *   `ual_task`, `ual_editor_bind` — the seven things a raw proxy cannot provide:
 *   images, the log ring, per-session rollback, lock merging, and DSH-owned
 *   background execution.
 *
 * The project brief says this is a **pure bridge with no agent logic**: DSH's own
 * agent plans, we only expose engine capability. That is why there is no task
 * planner, no retry-until-success loop, and no autonomous watchdog here.
 *
 * ## Approval: reused, never reinvented
 *
 * Risk gating goes through `tools/pre-execute` returning `{ kind: 'ask' }`, which
 * is DSH's own approval seam — the session's policy (`ask` / `never`) decides the
 * outcome, and a deployment with no answerer fails closed. Note the consequence
 * under a `never` policy: `ask` becomes an automatic rejection, which is the
 * correct reading of "unattended runs must not touch the editor".
 *
 * ## One undo buffer, shared
 *
 * UE gives the plugin a single agent transaction buffer per editor, not per DSH
 * session. The honest version of "每会话独立 Undo 栈" is therefore: track which
 * steps came from which session, and roll back only when this session's steps are
 * a clean LIFO suffix (`sessions/state.ts` explains why anything else would undo
 * somebody else's work).
 *
 * @module index
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreToolDecision, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { Config, DEFAULT_CONFIG, type ResolvedConfig } from './config.js'
import { UalService } from './service.js'
import { ScreenshotReader } from './tools/screenshot.js'
import { makeGenericTools } from './tools/generic.js'
import { makeOperationTools } from './tools/operations.js'
import { isKnown, riskOf, type Risk } from './catalog/methods.js'
import { notifierFor } from './sessions/state.js'

/** Cordis plugin name, used for fiber diagnostics and injected-context naming. */
export const name = 'unreal-agentlink'

/**
 * `tools` is required: without a registry the plugin has nothing to contribute.
 * Everything else (`approval`, `jobs`, `fs`, `attachments`, `agents`) is read with
 * `ctx.get`, so a composition that omits it degrades one feature instead of
 * failing the load — the same stance `dsh-tool-bash` takes for its optional seams.
 */
export const inject = ['tools']

export { Config }

/** The risks that must ask a human before touching the user's editor. */
const GATED: ReadonlySet<Risk> = new Set<Risk>(['destructive', 'dangerous'])

/** The tool whose `method` argument decides the risk. */
const METHOD_TOOLS = new Set(['ual_call', 'ual_task'])

export function apply(ctx: Context, config: ResolvedConfig = DEFAULT_CONFIG): void {
  const logger = ctx.logger('ualink')
  const service = new UalService(ctx, config)
  const screenshots = new ScreenshotReader(ctx, {
    maxBytes: config.screenshotMaxBytes,
    enabled: config.screenshotAttachments,
  })

  // `ctx.jobs` is optional, so the getter is called per invocation rather than
  // captured once at load.
  const jobsGetter = () => ctx.get('jobs')
  const tools: ToolDefinition[] = [...makeGenericTools(service), ...makeOperationTools(service, screenshots, jobsGetter)]
  for (const tool of tools) ctx.tools.register(tool)

  // ── approval gate ──────────────────────────────────────────────────────────
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const args = exec.arguments as { method?: string; calls?: { method?: string }[] } | undefined
    let worst: Risk | undefined

    if (METHOD_TOOLS.has(exec.name) && typeof args?.method === 'string') {
      worst = riskOf(args.method)
    } else if (exec.name === 'ual_batch' && Array.isArray(args?.calls)) {
      // One dangerous entry escalates the whole batch: a destructive call hidden
      // at index 4 of five must not ride in on the strength of four reads.
      const order: Record<Risk, number> = { read: 0, write: 1, destructive: 2, dangerous: 3 }
      for (const entry of args.calls) {
        if (typeof entry?.method !== 'string') continue
        const risk = riskOf(entry.method)
        if (worst === undefined || order[risk] > order[worst]) worst = risk
      }
    }
    // An unknown method is refused outright rather than forwarded into the editor.
    // This asks the catalog, not the risk table: `riskOf` answers 'dangerous' for
    // anything it has never heard of, so a prefix test would both deny real
    // methods that are merely risky (`level.save`, `content.migrate`) and wave
    // through invented ones that happen to share a prefix.
    const unknown = methodNames(exec.name, args).filter(method => !isKnown(method))
    if (unknown.length > 0) {
      return {
        kind: 'deny',
        reason: `UnrealAgentLink does not implement ${unknown.map(method => `"${method}"`).join(', ')}; ual_tools lists what exists`,
      }
    }
    if (worst === undefined || !GATED.has(worst)) return next()

    return {
      kind: 'ask',
      reason:
        worst === 'dangerous'
          ? `DSH 审批：${describe(exec.name, args, worst)} 被标记为「危险操作」，它会改变编辑器进程或落盘到本次会话之外`
          : `DSH 审批：${describe(exec.name, args, worst)} 被标记为「破坏性操作」，撤销可能无法完全恢复`,
    }
  })

  // ── bridge lifecycle ───────────────────────────────────────────────────────
  const bridge = service.bridge
  bridge.setNoteSink(message => logger.info(message))
  // A reconnecting editor must be re-taught the merged lock table, because
  // `locks.set` is a whole-table replace and the plugin clears its badges on
  // disconnect.
  bridge.on(event => {
    if (event.type === 'editor-identified' || event.type === 'editor-lost') {
      void service.pushLocksNow().catch(() => undefined)
      if (!config.notifyOnEditorChange) return
      notifyAgents(ctx, editorNotice(event))
      return
    }
    // The editor's Content Browser offers "send to the agent library", which
    // pushes one of these events and then only shows a notification if something
    // replies. This bridge is a pure bridge — it cannot perform an import — so the
    // event is surfaced instead of silently dropped, and no fabricated `res` is
    // sent back (a false "failed" dialog would be worse than silence).
    if (event.type === 'import') {
      logger.info(
        `editor sent ${event.method} (${describeImport(event.payload)}) — this bridge does not import assets; handle it in the editor or with the UEBox desktop app`,
      )
      notifyAgents(
        ctx,
        `The Unreal Editor sent an import request over the UnrealAgentLink bridge (${event.method}, ${describeImport(event.payload)}). This bridge does not import assets, so nothing was imported.`,
      )
    }
  })

  ctx.effect(async () => {
    try {
      await service.start()
      logger.info(`UnrealAgentLink bridge listening on ws://${config.host}:${config.port}`)
    } catch (error) {
      // The most likely cause by far: the UEBox desktop app owns 17860. Saying so
      // beats a stack trace about EADDRINUSE.
      const message = error instanceof Error ? error.message : String(error)
      logger.warn(
        `could not bind ws://${config.host}:${config.port} — ${message}. If the UEBox desktop app is running it owns port 17860; either close it, change "port" here, and launch the editor with -UALServer=ws://127.0.0.1:<port>`,
      )
    }
    return () => service.stop()
  })

  // ── per-session teardown ───────────────────────────────────────────────────
  // Rollback is opt-in (config.rollbackOnDispose) and only exact when this
  // session's steps are the LIFO suffix of the shared agent buffer.
  ctx.on('agent/disposed', ({ agent }) => {
    disposeSession(service, agent, config, logger)
  })
}

/** Every method name a gate-relevant tool call is about, in argument order. */
function methodNames(name: string, args: { method?: string; calls?: { method?: string }[] } | undefined): string[] {
  if (name === 'ual_batch') {
    return (args?.calls ?? []).flatMap(entry => (typeof entry?.method === 'string' ? [entry.method] : []))
  }
  return typeof args?.method === 'string' ? [args.method] : []
}

/**
 * Name the thing being approved, for a human reading an approval prompt.
 *
 * `ual_batch` has no `method` argument — it carries `calls[]` — so the single
 * command case and the batch case need different wording. An earlier version read
 * `args.method` for both, which made every batch prompt say
 * "batch containing (unknown method)" and told the approver nothing about what
 * they were approving.
 */
function describe(name: string, args: { method?: string; calls?: { method?: string }[] } | undefined, worst: Risk): string {
  if (name !== 'ual_batch') return `command ${args?.method ?? '(unknown method)'}`
  const methods = (args?.calls ?? []).flatMap(entry => (typeof entry?.method === 'string' ? [entry.method] : []))
  const risky = methods.filter(method => GATED.has(riskOf(method)))
  const detail = risky.length > 0 ? `危险项：${risky.join(', ')}` : `最危险项：${worst}`
  return `batch containing ${methods.length} call(s)（${detail}）`
}

/** One line for the agent, in the vocabulary the model already has. */
function editorNotice(event: { type: string; session?: { sessionId?: string; info?: Record<string, unknown> }; reason?: string }): string {
  const project = (event.session?.info?.projectName as string | undefined) ?? event.session?.sessionId ?? 'an editor'
  if (event.type === 'editor-identified') return `Unreal Editor connected to the UnrealAgentLink bridge: ${project}`
  return `Unreal Editor disconnected from the UnrealAgentLink bridge (${project}): ${event.reason ?? 'socket closed'}. Editor commands will fail until it reconnects (the plugin retries every 5s).`
}

/**
 * One line describing an import push without dumping the whole asset list.
 *
 * `content.import_folder` carries `paths`, `content.import_assets` carries
 * `asset_paths`; both may carry `asset_metadata`. Only the count matters for a
 * log line — the full payload is available to a caller that subscribes.
 */
function describeImport(payload: Record<string, unknown>): string {
  const paths = Array.isArray(payload.paths)
    ? payload.paths
    : Array.isArray(payload.asset_paths)
      ? payload.asset_paths
      : []
  const metadata = Array.isArray(payload.asset_metadata) ? payload.asset_metadata.length : 0
  const count = paths.length || metadata
  const first = paths.find(path => typeof path === 'string') as string | undefined
  return `${count} item(s)${first ? `, first: ${first}` : ''}`
}

/**
 * Best-effort context injection for every live agent.
 *
 * `agent.inject` is not a wake-up — an idle agent stays idle and reads this on its
 * next request — which is exactly right for "an editor came and went". One dead
 * agent must not stop the broadcast, so each target is attempted independently.
 */
function notifyAgents(ctx: Context, text: string): void {
  const agents = ctx.get('agents') as { list(): Agent[] } | undefined
  if (!agents) return
  for (const agent of agents.list()) notifierFor(agent, name)(text)
}

function disposeSession(
  service: UalService,
  agent: Agent,
  config: ResolvedConfig,
  logger: { info: (message: string) => void; warn: (message: string) => void },
): void {
  const session = String(agent.id)
  const state = service.sessions.peek(session)
  if (!state) return
  const steps = state.ledger.length
  const locks = state.locks.size

  // Release this session's lock claims first: the merged table must not keep
  // badging assets nobody is editing any more.
  if (locks > 0) service.clearLocks(session)

  if (!config.rollbackOnDispose || steps === 0) {
    service.sessions.drop(session)
    if (steps > 0 && !config.rollbackOnDispose) {
      logger.info(`session ${session} ended with ${steps} recorded editor step(s); rollbackOnDispose is off, so nothing was undone`)
    }
    return
  }

  if (!service.sessions.canRollbackLifo(session)) {
    // Undoing here would also undo another session's work. Report instead.
    service.sessions.drop(session)
    logger.warn(`session ${session} ended with ${steps} step(s) that are not a LIFO suffix of the agent undo buffer — NOT rolled back, another session acted after it`)
    return
  }

  service.sessions.drop(session)
  void service
    .call({ method: 'editor.undo', params: { steps }, session })
    .then(outcome => {
      if (outcome.value.ok) logger.info(`rolled back ${steps} editor step(s) for session ${session}`)
      else logger.warn(`rollback for session ${session} failed: ${outcome.value.error}`)
    })
    .catch(error => logger.warn(`rollback for session ${session} threw: ${error instanceof Error ? error.message : String(error)}`))
  // An editor that is already gone cannot roll anything back; the log line above
  // is the report, and the user still has the editor's own undo history.
}
