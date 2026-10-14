/**
 * Plugin configuration, as one Schemastery schema.
 *
 * Defaults are chosen so the plugin is *inert-but-alive* out of the box: it
 * listens, it reports, it refuses dangerous work behind DSH's approval gate — and
 * it does nothing on its own. The two defaults worth arguing about:
 *
 * - `rollbackOnDispose: false`. Undoing a session's editor work because a DSH
 *   session ended is a surprise the user did not ask for, and UE's agent undo
 *   buffer is shared, so "only our steps" is exact only in the LIFO case
 *   (see `sessions/state.ts`). Opt in.
 * - there is no `allowDangerous` field, because that must not be a plugin config
 *   value: the risk gate goes through `tools/pre-execute` and DSH's approval seam,
 *   which is where the user's policy lives.
 *
 * @module config
 */

import type Schema from '@deepseek-ai/schemastery'
import { default as SchemaNS } from '@deepseek-ai/schemastery'

/** The resolved configuration `apply` receives. */
export interface Config {
  /** Where the bridge listens. UE dials `ws://127.0.0.1:17860` by default. */
  host: string
  port: number
  /** Per-call default timeout. Blocking commands raise this per method. */
  timeoutMs: number
  /** Session read-cache TTL. Short on purpose: collapse a burst, not memoize a level. */
  cacheTtlMs: number
  cacheMaxEntries: number
  /** Editor commands per second. 0 disables the limiter. */
  rateLimitRps: number
  rateLimitQueue: number
  /** Consecutive transport failures before the circuit opens. */
  breakerThreshold: number
  breakerCooldownMs: number
  /** Retained `log.entry` lines in the bridge ring. */
  logCapacity: number
  /** Drop lines more verbose than this. */
  logMinLevel: LogVerbosity
  /**
   * Whether the plugin should assume UE-side log forwarding is on. The cvar
   * `ual.ForwardLogs` can only be set inside the editor, so the bridge cannot
   * enable it itself; `ual_logs` then only reads what UE happened to push.
   */
  logForwardingEnabled: boolean
  /** Roll the session's LIFO steps back when its agent is disposed. */
  rollbackOnDispose: boolean
  /** Inject an agent notice when an editor connects or drops. */
  notifyOnEditorChange: boolean
  /** Turn screenshot files into image blocks via `ctx.attachments`. */
  screenshotAttachments: boolean
  /** Largest screenshot bytes accepted for attachment, guarding the prompt. */
  screenshotMaxBytes: number
  /** Cap on `ual_batch` calls in one tool invocation. */
  maxBatchCalls: number
}

export type LogVerbosity = (typeof LOG_VERBOSITY)[number]

/** Ascending severity, matching the plugin's `ELogVerbosity` names. */
export const LOG_VERBOSITY = ['Fatal', 'Error', 'Warning', 'Display', 'Log', 'Verbose', 'VeryVerbose'] as const

export const DEFAULT_CONFIG: Config = {
  host: '127.0.0.1',
  port: 17_860,
  timeoutMs: 180_000,
  cacheTtlMs: 2_000,
  cacheMaxEntries: 128,
  rateLimitRps: 5,
  rateLimitQueue: 32,
  breakerThreshold: 3,
  breakerCooldownMs: 30_000,
  logCapacity: 512,
  logMinLevel: 'Display',
  logForwardingEnabled: false,
  rollbackOnDispose: false,
  notifyOnEditorChange: true,
  screenshotAttachments: true,
  screenshotMaxBytes: 12 * 1024 * 1024,
  maxBatchCalls: 12,
}

const { object, string, natural, boolean, union } = SchemaNS

/**
 * The runtime schema. Every field carries its default here, because cordis fills
 * defaults from the schema — a value two deployments may want differently has to be
 * a field, not a constant (the project-wide rule in `docs/user/develop/basic/config.md`).
 */
export const Config = object({
  host: string()
    .default(DEFAULT_CONFIG.host)
    .description('WebSocket bind address. Keep it loopback: UnrealAgentLink has no authentication, so reaching this port means driving the editor.'),
  port: natural()
    .min(1)
    .max(65_535)
    .default(DEFAULT_CONFIG.port)
    .description('Port the UE plugin dials into. 17860 is the plugin default; the UEBox desktop app also claims it.'),
  timeoutMs: natural().default(DEFAULT_CONFIG.timeoutMs).description('Default per-command timeout; blocking commands use their own higher floor'),
  cacheTtlMs: natural().default(DEFAULT_CONFIG.cacheTtlMs).description('Per-session read-cache TTL'),
  cacheMaxEntries: natural().default(DEFAULT_CONFIG.cacheMaxEntries).description('Per-session read-cache entry cap'),
  rateLimitRps: natural().default(DEFAULT_CONFIG.rateLimitRps).description('Editor commands per second; 0 disables the limiter'),
  rateLimitQueue: natural().default(DEFAULT_CONFIG.rateLimitQueue).description('Queued waiters allowed before rejecting'),
  breakerThreshold: natural().default(DEFAULT_CONFIG.breakerThreshold).description('Consecutive transport failures that open the circuit'),
  breakerCooldownMs: natural().default(DEFAULT_CONFIG.breakerCooldownMs).description('How long the circuit stays open'),
  logCapacity: natural().default(DEFAULT_CONFIG.logCapacity).description('Retained UE log lines'),
  logMinLevel: union(LOG_VERBOSITY).default(DEFAULT_CONFIG.logMinLevel).description('Drop log lines more verbose than this'),
  logForwardingEnabled: boolean()
    .default(DEFAULT_CONFIG.logForwardingEnabled)
    .description('Set true only after enabling the ual.ForwardLogs console variable inside the editor'),
  rollbackOnDispose: boolean()
    .default(DEFAULT_CONFIG.rollbackOnDispose)
    .description('Undo this session\u2019s steps when its agent is disposed — only when they are a clean LIFO suffix'),
  notifyOnEditorChange: boolean().default(DEFAULT_CONFIG.notifyOnEditorChange).description('Inject an agent notice when an editor connects or drops'),
  screenshotAttachments: boolean().default(DEFAULT_CONFIG.screenshotAttachments).description('Read screenshot files into image blocks via ctx.attachments'),
  screenshotMaxBytes: natural().default(DEFAULT_CONFIG.screenshotMaxBytes).description('Largest screenshot to attach to a result'),
  maxBatchCalls: natural().default(DEFAULT_CONFIG.maxBatchCalls).description('Maximum calls in one ual_batch'),
})

/** The resolved config shape the plugin reads. */
export type ResolvedConfig = Config
