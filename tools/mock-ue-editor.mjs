#!/usr/bin/env node
/**
 * A fake Unreal Editor for testing this bridge without Unreal Engine installed.
 *
 * ## Why this exists
 *
 * UnrealAgentLink has no HTTP surface and no simulation mode: the *editor* dials
 * **out** to `ws://127.0.0.1:17860` (`StartupModule()` in the vendored C++), so
 * every part of this plugin that matters — the socket, the `req`/`res` correlation,
 * the `project.info` handshake substitute, the 10 s heartbeat, the log ring, the
 * screenshot-as-a-file-path dance — can only be exercised end to end with an
 * editor on the other end. Requiring UE for that made the interesting half of the
 * plugin untestable on a machine that does not ship with a 100 GB engine.
 *
 * So this script *is* the other end. It is a WebSocket **client** that connects to
 * the bridge exactly like the real plugin build does, then answers every request
 * with a body shaped by the catalog's own documented result keys
 * (`src/catalog/method-data.ts` → `RESULT_KEYS`), so the answers are the shapes the
 * docs promise rather than shapes invented by whoever wrote the test.
 *
 * ## Usage
 *
 * ```console
 * # terminal 1 — the bridge (any dsh profile with the plugin loaded, or:)
 * node -e "import('./lib/service.js').then(async m => { const s = new m.UalService({logger:()=>console}, (await import('./lib/config.js')).DEFAULT_CONFIG); await s.start() })"
 *
 * # terminal 2 — the fake editor
 * node tools/mock-ue-editor.mjs
 * ```
 *
 * Or let `npm run smoke` do both (see `tools/ual-smoke.mjs`), which is the
 * supported entry point: it starts the service, starts this editor, and calls
 * every registered tool.
 *
 * ## Flags
 *
 * | flag | default | meaning |
 * | --- | --- | --- |
 * | `--url <ws://…>` | `ws://127.0.0.1:17860` | where to dial (the bridge's listen address) |
 * | `--project <name>` | `MockProject` | `project.info.projectName` |
 * | `--project-path <p>` | `K:/MockUE/MockProject` | `project.info.projectPath` |
 * | `--engine <ver>` | `5.6.0` | `project.info.engineVersion` |
 * | `--level <name>` | `MockMap` | `project.info.currentLevelName` |
 * | `--no-heartbeat` | off | suppress the `system.heartbeat` push |
 * | `--heartbeat-interval <ms>` | `10000` | heartbeat period |
 * | `--no-logs` | off | suppress the `log.entry` push |
 * | `--log-interval <ms>` | `2000` | `log.entry` period |
 * | `--no-identify` | off | suppress the `project.info` push (tests sessions with no identity) |
 * | `--shot-dir <dir>` | `<tmp>/ual-mock-shots` | where screenshot PNGs are written |
 * | `--delay <ms>` | `0` | delay every reply (timeout testing) |
 * | `--drop <method>` | — | never answer this method (repeatable) |
 * | `--fail <method>[:code[:message]]` | — | answer this method with an error code (repeatable) |
 * | `--result-keys <n>` | `6` | how many extra documented keys a generic body carries |
 * | `--transcript <file>` | — | append every frame as JSONL |
 * | `--quiet` | off | only log warnings |
 * | `--once` | off | exit after the first request |
 *
 * ## What it does not do
 *
 * It does not simulate Unreal: it does not check `params` against the handler's
 * real argument parsing (only the bridge-side `requires` gate is real), it does
 * not mutate state between calls, and its accepted status codes are the catalog's
 * `200` for everything it is not explicitly told to fail. It is a **protocol**
 * double, in the same spirit as the `FakeEditor` in `tests/end-to-end.test.ts`,
 * with the difference that it is a separate process reachable over a real socket,
 * so it also proves the code that runs in production rather than an in-process
 * stand-in.
 *
 * @module tools/mock-ue-editor
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { WebSocket } from 'ws'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { METHODS, METHOD_NAMES, riskOf } = await import(new URL('../lib/catalog/methods.js', import.meta.url))
const { RESULT_KEYS } = await import(new URL('../lib/catalog/method-data.js', import.meta.url))

/** Envelope version the real plugin writes. It is never read back. */
const UAL_VERSION = '1.0'
/** Default dial-in port, from `ws://127.0.0.1:17860` in `StartupModule()`. */
const UAL_DEFAULT_URL = 'ws://127.0.0.1:17860'

// ── arguments ───────────────────────────────────────────────────────────────

function usage() {
  const lines = ['usage: node tools/mock-ue-editor.mjs [flags]', '', 'flags:']
  for (const line of [
    '  --url <ws://host:port>     where to dial (default ws://127.0.0.1:17860)',
    '  --project <name>           project.info.projectName (default MockProject)',
    '  --project-path <path>      project.info.projectPath',
    '  --engine <version>         project.info.engineVersion (default 5.6.0)',
    '  --level <name>             project.info.currentLevelName (default MockMap)',
    '  --no-heartbeat             suppress the system.heartbeat push',
    '  --heartbeat-interval <ms>  heartbeat period (default 10000)',
    '  --no-logs                  suppress the log.entry push',
    '  --log-interval <ms>        log.entry period (default 2000)',
    '  --no-identify              suppress the project.info push',
    '  --shot-dir <dir>           where screenshot PNGs are written',
    '  --delay <ms>               delay every reply (default 0)',
    '  --drop <method>            never answer this method (repeatable)',
    '  --fail <method>[:code[:message]]   answer this method with an error (repeatable)',
    '  --result-keys <n>          documented keys per generic body (default 6)',
    '  --transcript <file>        append every frame as JSONL',
    '  --quiet                    only log warnings',
    '  --once                     exit after the first request',
    '  --lifetime <ms>            close and exit after this long, even with no request (default off)',
    '  --help                     this text',
  ]) lines.push(line)
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = {
    url: UAL_DEFAULT_URL,
    projectName: 'MockProject',
    projectPath: 'K:/MockUE/MockProject',
    engineVersion: '5.6.0',
    levelName: 'MockMap',
    heartbeat: true,
    heartbeatInterval: 10_000,
    logs: true,
    logInterval: 2_000,
    identify: true,
    shotDir: join(tmpdir(), 'ual-mock-shots'),
    delay: 0,
    drop: new Set(),
    fail: new Map(),
    resultKeys: 6,
    transcript: undefined,
    quiet: false,
    once: false,
    lifetime: 0,
  }
  const needs = (flag) => {
    const value = argv.shift()
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  while (argv.length > 0) {
    const flag = argv.shift()
    switch (flag) {
      case '--url': options.url = needs(flag); break
      case '--project': options.projectName = needs(flag); break
      case '--project-path': options.projectPath = needs(flag); break
      case '--engine': options.engineVersion = needs(flag); break
      case '--level': options.levelName = needs(flag); break
      case '--no-heartbeat': options.heartbeat = false; break
      case '--heartbeat-interval': options.heartbeatInterval = Number(needs(flag)); break
      case '--no-logs': options.logs = false; break
      case '--log-interval': options.logInterval = Number(needs(flag)); break
      case '--no-identify': options.identify = false; break
      case '--shot-dir': options.shotDir = needs(flag); break
      case '--delay': options.delay = Number(needs(flag)); break
      case '--drop': options.drop.add(needs(flag)); break
      case '--fail': {
        const [method, code, ...rest] = needs(flag).split(':')
        options.fail.set(method, { code: code === undefined ? 500 : Number(code), message: rest.join(':') || `${method} failed inside the mock editor` })
        break
      }
      case '--result-keys': options.resultKeys = Number(needs(flag)); break
      case '--transcript': options.transcript = needs(flag); break
      case '--quiet': options.quiet = true; break
      case '--once': options.once = true; break
      case '--lifetime': options.lifetime = Number(needs(flag)); break
      case '--help': case '-h': process.stdout.write(`${usage()}\n`); process.exit(0); break
      default: throw new Error(`unknown flag: ${flag}\n\n${usage()}`)
    }
  }
  return options
}

// ── logging ─────────────────────────────────────────────────────────────────

const options = parseArgs(process.argv.slice(2))

function log(...parts) {
  if (!options.quiet) process.stdout.write(`${parts.join(' ')}\n`)
}

function warn(...parts) {
  process.stdout.write(`mock-ue-editor: ${parts.join(' ')}\n`)
}

function transcript(direction, frame) {
  if (!options.transcript) return
  try {
    mkdirSync(dirname(options.transcript), { recursive: true })
    appendFileSync(options.transcript, `${JSON.stringify({ at: new Date().toISOString(), direction, frame })}\n`, 'utf8')
  } catch (error) {
    warn(`could not write transcript: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── a real PNG, so ual_screenshot has real bytes to read ────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/**
 * A valid RGB PNG: a purple-to-teal gradient with a brighter band, so the image
 * is obviously synthetic when a human looks at the attachment.
 */
function gradientPng(width, height) {
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * stride
    raw[row] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3
      const fx = x / Math.max(1, width - 1)
      const fy = y / Math.max(1, height - 1)
      const band = Math.abs(fy - 0.5) < 0.06 ? 60 : 0
      raw[p] = Math.round(90 * fx + 40 * fy + band)
      raw[p + 1] = Math.round(70 * (1 - fx) + 60 * fy + band)
      raw[p + 2] = Math.round(160 * (1 - fy) + 40 * fx + band)
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length, 0)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body), 0)
    return Buffer.concat([length, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let shotCount = 0

function writeShot(method, width, height) {
  mkdirSync(options.shotDir, { recursive: true })
  const filename = `mock-${method.replace(/[^a-z0-9]+/gi, '-')}-${++shotCount}.png`
  const path = join(options.shotDir, filename)
  writeFileSync(path, gradientPng(width, height))
  return { path, filename }
}

// ── reply bodies ────────────────────────────────────────────────────────────

/** Keys whose documented type is a boolean. */
const TRUE_KEYS = new Set([
  'ok', 'saved', 'applied', 'accepted', 'ran', 'success', 'verified', 'registered', 'undoable', 'truncated',
  'compiled', 'connected', 'closing', 'stopping', 'restarting', 'focused', 'moved', 'changed', 'removed',
  'deleted', 'empty', 'is_dirty', 'is_temporary', 'is_enabled', 'is_variable', 'is_connected', 'is_const',
  'is_reference', 'is_array', 'is_ghost_node', 'is_loaded', 'is_visible', 'has_code', 'has_navmesh',
  'has_errors', 'has_controller', 'pending_restart', 'needs_save', 'restart_required', 'default_enabled',
  'always_loaded', 'visible_at_runtime', 'visible_in_editor', 'walkable', 'nanite', 'nanite_enabled',
  'two_sided', 'substrate_enabled', 'is_perspective', 'is_active_viewport', 'on_target', 'was_broken',
  'runtime_error', 'interrupted', 'session_active', 'paused', 'playing', 'cinematic_mode', 'partitioned',
  'is_partial', 'found', 'dry_run', 'level_saved', 'sequence_saved', 'package_on_disk', 'object_in_memory',
])

/** Keys whose documented type is a number. */
const NUMBER_KEYS = new Set([
  'count', 'total', 'total_found', 'total_candidates', 'total_node_count', 'match_count', 'returned',
  'index', 'step', 'steps_applied', 'undoable', 'redoable', 'remaining', 'progress', 'width', 'height',
  'x', 'y', 'z', 'r', 'g', 'b', 'a', 'radius', 'distance', 'size', 'elapsed_ms', 'elapsed_seconds',
  'requested_seconds', 'actual_elapsed_seconds', 'fps', 'avg_fps', 'p99_fps', 'frame_ms', 'gpu_ms',
  'render_thread_ms', 'rhi_thread_ms', 'game_thread_ms', 'worst_frame', 'idle_sample', 'frame_count',
  'actor_count', 'node_count', 'widget_count', 'row_count', 'graph_count', 'key_count', 'track_count',
  'binding_total', 'object_count', 'parameter_count', 'component_count', 'instance_count',
  'partitioned_instance_count', 'scanned', 'applied_count', 'failed_count', 'saved_count', 'skipped_count',
  'imported_count', 'moved_count', 'written_count', 'deleted_count', 'total_files', 'scanned_files',
  'total_assets', 'row_count', 'triangles', 'vertices', 'lod_count', 'material_slots', 'package_size_bytes',
  'resource_bytes', 'texture_bytes', 'disk_size', 'total_disk_size', 'duration_frames', 'playback_start',
  'playback_end', 'z_order', 'slot_index', 'pos_x', 'pos_y', 'node_width', 'node_height', 'font_size',
  'version_major', 'version_minor', 'frame_range', 'frames', 'total_frames', 'output_frame', 'cell',
  'jumps', 'length', 'frame', 'game_time', 'seq', 'log_cursor', 'truncated_hint',
])

/** Keys documented as arrays of objects or strings. */
const ARRAY_KEYS = new Set([
  'actors', 'names', 'paths', 'entries', 'objects', 'packages', 'results', 'messages', 'categories',
  'errors', 'warnings', 'nodes', 'edges', 'pins', 'inputs', 'outputs', 'params', 'properties',
  'suggestions', 'diagnostics', 'files', 'items', 'levels', 'assets', 'components', 'slots', 'bindings',
  'tracks', 'sections', 'channels', 'points', 'findings', 'reports', 'keys', 'rows', 'columns', 'modules',
  'plugins', 'landscapes', 'types', 'referencers', 'dependencies', 'notes', 'details', 'problems',
  'events', 'sensors', 'targets', 'logs', 'print_strings', 'written_keys', 'candidate_resolutions',
  'violations', 'failures', 'top_contributors', 'nodes_truncated', 'edges_truncated', 'items_truncated',
  'broken_bindings', 'unresolved_bindings', 'camera_cuts', 'skipped_keys', 'replaced_keys',
])

/** Keys that read as a UE object path. */
const PATH_KEYS = new Set([
  'path', 'file_path', 'source_path', 'destination_path', 'asset_path', 'material_path', 'blueprint_path',
  'sequence_path', 'graph_path', 'context_path', 'action_path', 'uproject_path', 'csv_path', 'utrace_path',
  'map_path', 'preset_path', 'output_dir', 'content_dir', 'engine_dir', 'engine_source_dir', 'plugins_dir',
  'project_dir', 'project_source_dir', 'saved_dir', 'intermediate_dir', 'base_dir', 'asset_id',
])

function placeholder(method, key) {
  if (ARRAY_KEYS.has(key)) return []
  if (TRUE_KEYS.has(key)) return true
  if (NUMBER_KEYS.has(key)) return 1
  if (PATH_KEYS.has(key)) return `/Game/Mock/MockAsset.MockAsset`
  switch (key) {
    case 'name': case 'label': case 'title': case 'actor_label': case 'graph_name':
      return 'MockActor_1'
    case 'class': case 'type': case 'target_type': case 'component_class': case 'node_class':
      return 'StaticMeshActor'
    case 'message': case 'note': case 'text': case 'summary': case 'reason': case 'details':
      return `${method}: mocked by tools/mock-ue-editor.mjs`
    case 'output': case 'engine_log': case 'output_note':
      return 'mock console output'
    default:
      return `mock:${key}`
  }
}

/**
 * A generic body: `ok: true` plus a bounded, deterministic slice of the keys the
 * command reference documents for this method. Bounded on purpose — a real
 * handler answers with the keys it has, not with the whole union.
 */
function genericBody(method) {
  const documented = RESULT_KEYS[method] ?? []
  const body = {}
  if (documented.includes('ok') || riskOf(method) !== 'read') body.ok = true
  let extras = 0
  for (const key of documented) {
    if (key === 'ok' || key === 'error') continue
    if (extras >= options.resultKeys) break
    extras += 1
    body[key] = placeholder(method, key)
  }
  return body
}

/**
 * Bodies for the methods the tools themselves call, plus the ones a human
 * smoke run wants to look at. Everything here keeps the documented key names
 * exactly — the point of the mock is to be the docs' shape, not a nicer one.
 */
const OVERRIDES = {
  'system.get_project_info': () => ({
    ok: true,
    project_name: options.projectName,
    project_path: options.projectPath,
    project_dir: `${options.projectPath}/`,
    content_dir: `${options.projectPath}/Content/`,
    engine_version: options.engineVersion,
    engine_major: Number(options.engineVersion.split('.')[0]) || 5,
    engine_minor: Number(options.engineVersion.split('.')[1]) || 6,
    plugin_version: '1.2.14',
    plugin_build: 'mock',
    plugins_dir: 'K:/MockUE/Engine/Plugins/',
    saved_dir: `${options.projectPath}/Saved/`,
    intermediate_dir: `${options.projectPath}/Intermediate/`,
    engine_dir: 'K:/MockUE/Engine/',
    engine_source_dir: 'K:/MockUE/Engine/Source/',
    project_source_dir: `${options.projectPath}/Source/`,
    has_code: false,
    python: true,
    blueprint_require_empty: true,
    material_fail_if_exists: true,
    capabilities: { blueprint_require_empty: true, material_fail_if_exists: true, python: true },
  }),
  'editor.get_project_info': () => ({ ok: true, project_name: options.projectName, engine_version: options.engineVersion }),
  'project.info': () => ({ ok: true, project_name: options.projectName, engine_version: options.engineVersion }),

  'actor.get': () => ({
    ok: true,
    count: 2,
    actors: [
      { name: 'Floor', label: 'Floor', path: `/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Floor`, class: 'StaticMeshActor', location: { x: 0, y: 0, z: 0 } },
      { name: 'Cube_1', label: 'Cube_1', path: `/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Cube_1`, class: 'StaticMeshActor', location: { x: 120, y: 0, z: 50 } },
    ],
    names: ['Floor', 'Cube_1'],
    paths: [`/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Floor`, `/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Cube_1`],
  }),
  'actor.get_info': () => ({ ok: true, count: 1, total_found: 1, actors: [{ name: 'Cube_1', class: 'StaticMeshActor', mobility: 'Movable', tags: [] }] }),
  'actor.set_transform': () => ({
    ok: true,
    count: 1,
    applied: 1,
    failed: 0,
    failed_count: 0,
    actors: [{ name: 'Cube_1', path: `/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Cube_1`, ok: true, location: { x: 200, y: 0, z: 50 } }],
    affected_packages: [`/Game/Maps/${options.levelName}`],
  }),
  'actor.spawn': () => ({ ok: true, count: 1, created: [{ name: 'Cube_2', class: 'StaticMeshActor', path: `/Game/Maps/${options.levelName}.${options.levelName}:PersistentLevel.Cube_2` }], requested: 1, instances: 1 }),
  'actor.destroy': () => ({ ok: true, count: 1, target_count: 1, deleted_actors: [{ name: 'Cube_2', class: 'StaticMeshActor' }] }),

  'level.get_current': () => ({ ok: true, name: options.levelName, package: `/Game/Maps/${options.levelName}`, actor_count: 2, is_dirty: false, is_temporary: false }),
  'level.list': () => ({ ok: true, levels: [`/Game/Maps/${options.levelName}`], count: 1 }),
  'level.save': () => ({ ok: true, name: options.levelName, package: `/Game/Maps/${options.levelName}`, saved_as: `/Game/Maps/${options.levelName}`, saved_file: `${options.projectPath}/Content/Maps/${options.levelName}.umap`, saved_level_is_persistent: true, is_dirty: false, actor_count: 2 }),

  'editor.screenshot': () => {
    const resolution = 320
    const { path, filename } = writeShot('editor.screenshot', resolution, 180)
    return {
      saved: true, path, filename, width: resolution, height: 180,
      method: 'mock::FViewport::ReadPixels', world: 'editor', view: 'perspective',
      camera_source: 'viewport', exposure: 'manual',
      pending_shaders: 0, pending_assets: 0, streaming_in_flight: 0,
      x: 0, y: 0, z: 320, pitch: -12, yaw: 45, roll: 0,
      camera_location: { x: 0, y: 0, z: 320 }, camera_rotation: { pitch: -12, yaw: 45, roll: 0 },
      warmup_frames: 3, wait_ms: 120, restore_app_window: true,
    }
  },
  'editor.capture_app_window': () => {
    const { path, filename } = writeShot('editor.capture_app_window', 640, 360)
    return { saved: true, path, filename, width: 640, height: 360, window_title: 'Unreal Editor — MockProject', window_source: 'mock::AppWindow' }
  },
  'widget.preview': () => {
    const { path } = writeShot('widget.preview', 256, 144)
    return { ok: true, path, width: 256, height: 144 }
  },

  'editor.undo': () => ({ ok: true, steps_applied: 1, step_titles: ['Move Cube_1'], remaining: 0, redoable: 1, action: 'Move', affected_packages: [`/Game/Maps/${options.levelName}`], affected_objects: ['Cube_1'] }),
  'editor.redo': () => ({ ok: true, steps_applied: 1, step_titles: ['Move Cube_1'], remaining: 1, redoable: 0, action: 'Move', affected_packages: [`/Game/Maps/${options.levelName}`], affected_objects: ['Cube_1'] }),
  'editor.undo_history': () => ({
    ok: true,
    undoable: 1,
    redoable: 1,
    returned: 1,
    count: 1,
    entries: [{ step: 1, title: 'Move Cube_1', packages: [`/Game/Maps/${options.levelName}`], objects: ['Cube_1'], context: 'agent' }],
  }),
  'editor.get_dirty': () => ({ ok: true, is_level: true, package: `/Game/Maps/${options.levelName}`, touched: [], touched_count: 0, other: [], other_count: 0 }),
  'editor.save': () => ({ ok: true, scope: 'all', saved_count: 1, skipped_count: 0, failed_count: 0, saved: [{ package: `/Game/Maps/${options.levelName}`, file: `${options.projectPath}/Content/Maps/${options.levelName}.umap` }] }),

  'viewport.focus': () => ({ focused: true, on_target: true, moved: true, target_center: { x: 120, y: 0, z: 50 }, target_radius: 100, distance: 420, transition_settled: true, is_perspective: true, camera: { location: { x: 520, y: 0, z: 240 }, rotation: { pitch: -20, yaw: 180, roll: 0 } } }),

  'locks.set': (params) => ({ ok: true, locked: Array.isArray(params?.paths) ? params.paths.length : 0, paths: Array.isArray(params?.paths) ? params.paths : [], level_locked: params?.level_locked === true }),
  'locks.get': () => ({ ok: true, paths: [], level_locked: false, count: 0 }),

  // UAL_MessageLogCommands.cpp:120-124 — `list` takes no parameters and answers
  // with the category tree only, so the result has no top-level name/label.
  'messagelog.list': () => ({ categories: [{ name: 'LogTemp', label: 'LogTemp' }, { name: 'LogUnrealAgentLink', label: 'UnrealAgentLink' }] }),
  // UAL_MessageLogCommands.cpp:154-161 + SerializeMessage at 44-73 — `get` needs
  // one category, and each message is `{severity, text, tokens}`, not `{message}`.
  'messagelog.get': (params) => ({
    category: String(params?.category ?? ''),
    count: 2,
    total: 2,
    messages: [
      { severity: 'Warning', text: 'mock editor: nothing here is actually wrong, this is a fixture', tokens: [{ type: 'Text', text: 'mock editor: nothing here is actually wrong, this is a fixture' }] },
      { severity: 'Info', text: `mock editor: category ${String(params?.category ?? '')} reached the engine`, tokens: [{ type: 'Text', text: 'mock editor: category reached the engine' }] },
    ],
  }),

  'cmd.run_python': (params) => ({ result: `ran ${String(params?.script ?? '').slice(0, 40)}`, output: 'mock python output\n', output_truncated_chars: 0, output_note: 'mock' }),
  'system.run_console_command': (params) => ({ result: 'ok', output: `mock console: ${String(params?.command ?? '')}`, output_truncated_chars: 0, output_note: 'mock' }),
  'system.get_editor_health': () => ({ ok: true, healthy: true, is_compiling: false, pie_running: false, slow_task: null }),
  'system.get_performance_stats': () => ({ fps: 120, frame_ms: 8.3, game_thread_ms: 3.1, render_thread_ms: 4.2, gpu_ms: 5.5, rhi_thread_ms: 0.9 }),
  'sequence.render': (params) => ({ ok: true, job_id: 'mock-render-1', state: 'queued', output_dir: String(params?.output_dir ?? 'K:/MockUE/Renders'), sequence_path: String(params?.sequence_path ?? '/Game/Cinematics/MockSequence'), format: 'png', resolution: { x: 1920, y: 1080 }, frame_range: { start: 0, end: 120 }, renderer: 'MoviePipeline', warnings: [] }),
  'sequence.render_status': () => ({ state: 'finished', progress: 1, total_frames: 121, output_frame: 120, elapsed_seconds: 42.5, output_dir: 'K:/MockUE/Renders', job_id: 'mock-render-1' }),
  'pie.run': () => ({ ok: true, ran: true, requested_seconds: 2, elapsed_seconds: 2.1, frames: 120, actors_spawned: 1, actors_at_start: 2, actors_at_end: 2, error_count: 0, warning_count: 0, errors: [], warnings: [], print_strings: [], events: [], screenshot_path: null, stop_reason: 'time', at: 2 }),
  'pie.stop': () => ({ ok: true, stopping: true }),
  'pie.scene': () => ({ ok: true, level: options.levelName, has_navmesh: true, total_relevant: 1, truncated: false, player: { location: { x: 0, y: 0, z: 100 } }, pawn: { name: 'MockPawn', class: '/Script/Engine.DefaultPawn', location: { x: 0, y: 0, z: 100 } }, actors: [] }),
  'content.search': () => ({ ok: true, total: 1, count: 1, folder_count: 0, folder_counts: {}, folders: [], truncated: false, results: [{ name: 'M_Mock', path: '/Game/Mock/M_Mock', class: 'Material' }] }),
  'content.describe': () => ({ ok: true, name: 'M_Mock', path: '/Game/Mock/M_Mock', class: 'Material', package: '/Game/Mock/M_Mock', package_size_bytes: 4096, dependencies: [], dependencies_count: 0, referencers: [], referencers_count: 0 }),
  'material.create': () => ({ material_name: 'M_Mock', material_path: '/Game/Mock/M_Mock', material_package_path: '/Game/Mock', material_type: 'Surface', blend_mode: 'Opaque', two_sided: false, substrate_enabled: false, object_in_memory: true, package_on_disk: true, available_pins: [] }),
  'blueprint.create': () => ({ ok: true, name: 'BP_Mock', path: '/Game/Mock/BP_Mock', saved: true, existing_class: false, warnings: [] }),
  'anim.measure': () => ({ ok: true, measure: 1.75, unit: 'seconds' }),
  'cpp.list_modules': () => ({ has_code: false, count: 0, declared_module_count: 0, modules: [] }),
  'cpp.probe': () => ({ available: false, unavailable_reason: 'the mock editor has no compiled game code', has_code: false, is_compiling: false, live_coding: false, hot_reload: false, engine_dir: 'K:/MockUE/Engine/' }),
}

function replyBody(method, params) {
  const override = OVERRIDES[method]
  if (override) return override(params)
  if (!METHOD_NAMES.includes(method)) return undefined
  return genericBody(method)
}

// ── the fake editor ─────────────────────────────────────────────────────────

const stats = { connections: 0, requests: 0, unknown: 0, failures: 0, dropped: 0 }

function connect() {
  const socket = new WebSocket(options.url)
  let identified = false

  socket.on('open', () => {
    stats.connections += 1
    log(`mock-ue-editor: connected to ${options.url} (${METHOD_NAMES.length} methods known)`)
    if (options.identify) {
      identified = true
      push('project.info', {
        projectName: options.projectName,
        projectPath: options.projectPath,
        engineVersion: options.engineVersion,
        pluginBuild: 'mock',
        plugin_version: '1.2.14',
        runMode: 'Editor',
        interactive: true,
        currentLevelName: options.levelName,
        currentLevelPath: `/Game/Maps/${options.levelName}`,
        pythonAvailable: true,
      })
    }
  })

  const heartbeat = options.heartbeat
    ? setInterval(() => { if (socket.readyState === WebSocket.OPEN) push('system.heartbeat', {}) }, options.heartbeatInterval)
    : undefined

  let logSeq = 0
  const LOG_LINES = [
    { level: 'Log', category: 'LogUnrealAgentLink', text: 'UnrealAgentLink: bridge connected (mock)' },
    { level: 'Display', category: 'LogTemp', text: 'mock editor: viewport tick' },
    { level: 'Warning', category: 'LogTemp', text: 'mock editor: this line is a fixture, not a real warning' },
  ]
  const logs = options.logs
    ? setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return
        const line = LOG_LINES[logSeq % LOG_LINES.length]
        logSeq += 1
        push('log.entry', { ...line, seq: logSeq })
      }, options.logInterval)
    : undefined

  function push(method, payload) {
    const frame = { ver: UAL_VERSION, type: 'evt', method, payload }
    if (method !== 'system.heartbeat') log(`mock-ue-editor: -> ${method}`)
    transcript('out', frame)
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      warn(`push ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function stopTimers() {
    if (heartbeat) clearInterval(heartbeat)
    if (logs) clearInterval(logs)
    if (lifetime) clearTimeout(lifetime)
  }

  // A mock that only exits on the first request hangs forever when it is pointed
  // at a bridge that has nothing to ask it (e.g. a live instance), so this is a
  // wall-clock escape hatch for scripted probes.
  const lifetime = options.lifetime > 0
    ? setTimeout(() => {
        stopTimers()
        log(`mock-ue-editor: lifetime of ${options.lifetime} ms elapsed, exiting`)
        try { socket.close() } catch { /* already gone */ }
        process.exit(0)
      }, options.lifetime)
    : undefined

  socket.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(data.toString('utf8'))
    } catch {
      warn(`ignoring a frame that is not JSON: ${String(data).slice(0, 120)}`)
      return
    }
    transcript('in', frame)
    // Only `req` is ours to answer; the plugin never sends `evt`, but a bridge
    // that did would be ignored here exactly as UE ignores inbound non-`req`.
    if (frame?.type !== 'req' || typeof frame.method !== 'string' || typeof frame.id !== 'string') return
    stats.requests += 1
    void answer(frame, socket, () => identified)

    if (options.once) {
      stopTimers()
      setTimeout(() => socket.close(), 50)
    }
  })

  socket.on('close', () => {
    stopTimers()
    log(`mock-ue-editor: disconnected from ${options.url}`)
  })

  socket.on('error', (error) => {
    // UE retries every 5 s; a mock that exits on ECONNREFUSED would be useless
    // when it is started before the bridge.
    warn(`socket error: ${error instanceof Error ? error.message : String(error)}`)
  })
}

async function answer(frame, socket, isIdentified) {
  const { method, id } = frame
  const params = frame.params ?? {}

  if (options.drop.has(method)) {
    stats.dropped += 1
    log(`mock-ue-editor: <- ${method} (${id}) dropped on purpose`)
    return
  }

  if (options.delay > 0) await new Promise(resolve => setTimeout(resolve, options.delay))

  const injected = options.fail.get(method)
  if (injected) {
    stats.failures += 1
    send({ ver: UAL_VERSION, type: 'res', id, method, code: injected.code, result: { message: injected.message, details: { injected: true, by: 'tools/mock-ue-editor.mjs' } } })
    log(`mock-ue-editor: <- ${method} (${id}) -> ${injected.code} (injected)`)
    return
  }

  const body = replyBody(method, params)
  if (body === undefined) {
    stats.unknown += 1
    send({ ver: UAL_VERSION, type: 'res', id, method, code: 404, result: { message: `Unknown method: ${method}` } })
    log(`mock-ue-editor: <- ${method} (${id}) -> 404 unknown`)
    return
  }

  send({ ver: UAL_VERSION, type: 'res', id, method, code: 200, result: body })
  log(`mock-ue-editor: <- ${method} (${id}) -> 200${isIdentified() ? '' : ' (before project.info)'}`)

  function send(reply) {
    transcript('out', reply)
    try {
      socket.send(JSON.stringify(reply))
    } catch (error) {
      warn(`reply for ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ── lifecycle ───────────────────────────────────────────────────────────────

if (!Array.isArray(METHOD_NAMES) || METHOD_NAMES.length === 0) {
  warn('the catalog in lib/catalog/methods.js is empty or missing — run `npm run build` first')
  process.exit(1)
}

log(`mock-ue-editor: dialing ${options.url} as ${options.projectName} (${options.engineVersion}); screenshots -> ${options.shotDir}`)
connect()

const bye = (signal) => {
  log(`mock-ue-editor: ${signal} — ${JSON.stringify(stats)}`)
  process.exit(0)
}
process.on('SIGINT', () => bye('SIGINT'))
process.on('SIGTERM', () => bye('SIGTERM'))
