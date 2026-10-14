/**
 * The UnrealAgentLink command catalog: what exists, how dangerous it is, and
 * which ones are traps.
 *
 * ## Why a catalog and not ~170 tools
 *
 * The plugin registers 170 methods. Surfacing them as 170 model-facing tools
 * would spend a large slice of every request's prompt on capabilities an agent
 * rarely needs, and the project brief is explicit that this plugin is a **pure
 * bridge** — planning belongs to the DSH agent, not to us. So the model-facing
 * surface is:
 *
 * - `ual_status` / `ual_tools` / `ual_schema` / `ual_call` / `ual_batch` — the
 *   bridge, which reaches every cataloged method.
 * - `ual_screenshot`, `ual_logs`, `ual_undo`, `ual_undo_history`, `ual_locks`,
 *   `ual_task`, `ual_editor_bind` — the seven things a DSH session adds on top of
 *   a raw proxy (images, the log ring, per-session rollback, locks, long-job
 *   execution, editor binding).
 *
 * A name absent from this file is **refused**, not forwarded: `ual_call` will not
 * send an unmapped method into a user's editor. That makes the catalog the one
 * place where a mistake is visible, and it is why the method list is generated
 * from the plugin source (`scripts/extract-methods.mjs`) and asserted 1:1 against
 * it by `scripts/check-catalog.mjs` and the test suite — not typed from
 * documentation, which is stale in several places.
 *
 * ## Traps, all verified against `ueboxai/uebox@main`
 *
 * None of these are guessable from the shipped docs (several are contradicted by
 * them), and each one costs a hung editor or a silently-lost action:
 *
 * - **No async anything.** There is no `query_task` / `cancel_task`.
 *   `sequence.render`, `cpp.compile`, `blueprint.compile_all`, `pcg.execute`, an
 *   Interchange import, and `pie.run` block the game thread for their whole
 *   duration and reply only at the end. `sequence.render`'s `job_id` keys a
 *   `sequence.render_status` call that **cannot be served while the render runs**,
 *   so it is a record, not an escape hatch. The only honest model for long work is
 *   `ual_task` (a real `ctx.jobs` job holding a long bridge timeout).
 * - **Success is not `code === 200`.** `0` is never used; `207` means *partial*
 *   success with the failures in the body; and several handlers answer `200` with
 *   `result.ok === false` (`editor.undo`, `blueprint.compile`, `pie.observe`).
 *   Upstream's own DEVELOPING.md calls this class of bug out. See `service.judge`.
 * - **`on_registry_busy: "wait"` deadlocks.** It calls `WaitForCompletion()` on the
 *   game thread, the same thread the scan-completion delegate needs. Use `"fail"`
 *   (the default) and poll `content.registry_status`.
 * - **`editor.screenshot` returns a file path, not an image.** Its own Chinese doc
 *   claims a base64 `image` field and a `filepath` param; neither exists in the
 *   handler. The bridge reads the file off disk (see `tools/screenshot.ts`).
 * - **A screenshot with `pending_shaders > 0` is not the finished look** — the
 *   plugin reports the residue rather than swallowing it, because a model cannot
 *   tell a broken material from an uncompiled one by looking.
 * - **`locks.set` is cosmetic, and `enforced` is not.** No command consults the
 *   lock table to refuse work — the badges are UI only. But the `enforced` subset
 *   has its files marked READ-ONLY on disk, and engine Save All skips read-only
 *   packages *silently*. The bridge therefore never sends `enforced`.
 * - **`level.open` / `level.new` clear the agent undo buffer** while preparing for
 *   the map change, so a session's rollback budget dies with a level switch.
 * - `editor.quit` / `editor.restart` send their 200 and then kill the process; the
 *   socket drops immediately after the reply.
 * - `pie.click_widget`, `input.inject_key` and the pure-editor commands answer
 *   **409 while PIE is running**, with the suggestion to use `pie.*` instead.
 * - `content.delete` fails when the agent undo buffer still references the asset;
 *   `drop_agent_undo: true` answers it by discarding those steps permanently.
 * - `anim.*` registers on every engine version but answers **501 below UE 5.5**,
 *   from an `#else` branch that exists precisely so the method is not a 404.
 * - `input.map` **reads** the binding setup (it delegates to `Handle_GetInputMap`);
 *   the obvious name makes it look like a write, and classifying it as one would
 *   route a harmless query through the approval gate.
 *
 * ## Required keys are derived, never hand-written
 *
 * `service.call()` gates on `REQUIRED_KEYS` from the generated data, which is
 * harvested from the plugin's own `SendError(…, 400, TEXT("Missing field: X"))`
 * messages. The first draft of this catalog carried 101 hand-guessed `requires`
 * entries and 50 of them named a key the handler never reads (`asset_path` where
 * it reads `path`, `bounds` where it reads `graph_path`) — and a wrong required
 * key makes the bridge reject a *valid* call before the engine sees it, replacing
 * the engine's real error with a confident false one. Nothing is asserted mandatory
 * here unless the plugin says so itself.
 *
 * ## Dead methods, excluded on purpose
 *
 * `content.get_referencers`, `editor.play`, `editor.stop` are registered into the
 * wrong map upstream and answer 404 always; `actor.destroy_batch`,
 * `take_screenshot`, `messagelog.subscribe`/`unsubscribe` were deleted
 * 2026-09-16. They appear in `BLACKLIST` with the replacement to use, so the
 * bridge never advertises a capability the plugin does not have.
 *
 * @module catalog/methods
 */

import { UAL_REGISTERED_METHODS, PARAM_KEYS, REQUIRED_KEYS, METHOD_CODES } from './method-data.js'
import { EXTRA_PARAM_KEYS } from './method-overrides.js'

/**
 * - `read` — nothing changes; safe to retry, safe to cache.
 * - `write` — mutates the level or an asset; recorded in the session ledger.
 * - `destructive` — removes or overwrites something undo cannot fully restore
 *   (a deleted asset, replaced graph content). Always asks.
 * - `dangerous` — takes the editor down, writes outside the session, or runs
 *   arbitrary code (quit, restart, save, `.ini` write, C++ build, console command,
 *   `cmd.run_python`). Always asks, and never auto-runnable by any default.
 */
export type Risk = 'read' | 'write' | 'destructive' | 'dangerous'

export interface MethodSpec {
  readonly risk: Risk
  /** One line, for `ual_tools`. */
  readonly summary: string
  /** Pure reads may overlap in the registry's scheduler. */
  readonly concurrent?: boolean
  /** Blocks the game thread long enough that the default timeout is wrong. */
  readonly blocking?: boolean
  /** Per-method timeout floor, ms. */
  readonly timeoutMs?: number
  /** Keys the handler dereferences without a check; we refuse early instead. */
  readonly requires?: readonly string[]
  /** A trap worth putting in front of the model rather than letting it learn by crashing. */
  readonly warning?: string
  /** Safe to serve from the TTL cache for read-only queries. */
  readonly cacheable?: boolean
}

const read = (summary: string, extra: Partial<MethodSpec> = {}): MethodSpec => ({ risk: 'read', summary, concurrent: true, ...extra })
const write = (summary: string, extra: Partial<MethodSpec> = {}): MethodSpec => ({ risk: 'write', summary, ...extra })
const destroy = (summary: string, extra: Partial<MethodSpec> = {}): MethodSpec => ({ risk: 'destructive', summary, ...extra })
const danger = (summary: string, extra: Partial<MethodSpec> = {}): MethodSpec => ({ risk: 'dangerous', summary, ...extra })

/** `blocking: true` and a floor that keeps the default from mis-reading a slow editor as a dead one. */
const long = (extra: Partial<MethodSpec> = {}, floor = 300_000): Partial<MethodSpec> => ({ blocking: true, timeoutMs: floor, ...extra })

const REGISTRY_NOTE =
  'while the initial asset-registry scan runs this answers 503 registry_not_ready with progress in details — poll content.registry_status; never pass on_registry_busy:"wait", which deadlocks the game thread'

export const METHODS: Readonly<Record<string, MethodSpec>> = {
  // ── system / project ───────────────────────────────────────────────────────
  'system.get_project_info': read('engine and project facts, plus the capability flags that say what this plugin build supports', { cacheable: true }),
  'system.get_editor_health': read('startup cost, asset-registry state, hitch %, DDC hit rate, free memory (null means unavailable, not zero)', { cacheable: true }),
  'system.get_performance_stats': read('fps / frame / game / render / rhi / gpu ms', {
    warning: 'render_thread_ms reads 0 on some machines regardless of activity — it is not evidence the editor is idle' }),
  'system.run_console_command': danger('execute an arbitrary engine console command', {
    warning: 'unbounded side effects; output is truncated to 8000 chars and reports output_truncated_chars' }),
  'system.manage_plugin': danger('enable or disable a project plugin (rewrites the .uproject)', {}),
  'system.capture_perf_trace': write('capture a CSV or Unreal Insights perf trace', {
    ...long({}, 120_000),
    warning: 'CSV profiling is exclusive — a second request while one runs gets 409' }),
  'system.capture_insights_trace': write('capture an Insights trace', long({}, 120_000)),
  'project.info': read('the same payload as the project.info event, on demand', { cacheable: true }),
  'editor.get_project_info': read('alias of project.info', { cacheable: true }),
  'project.get_config': read('read one value from a project .ini', { cacheable: true }),
  'project.set_config': danger('write one value into a project .ini (outlives the session, survives undo)', {}),
  'project.analyze_uproject': read('validate a .uproject: missing plugins, bad EngineAssociation', { cacheable: true }),
  'project.check_asset_guidelines': read('the project asset-guideline verdict', { cacheable: true }),
  'project.apply_asset_guidelines': danger('write the project asset guidelines, which every other tool then inherits'),

  // ── actors ─────────────────────────────────────────────────────────────────
  'actor.spawn': write('spawn one or many actors from asset_id aliases, asset paths, or class names', {
    warning: 'batch is capped by the ual.MaxBatchCreate cvar (default 50); an over-cap request returns 413' }),
  'actor.get': read('list actors, by name/path or a targets selector', { cacheable: true }),
  'actor.get_info': read('the unified selector query, with transform/bounds options and system-actor accounting', { cacheable: true }),
  'actor.inspect': read('read a bounded property set off selected actors (default whitelist Mobility/bHidden/CollisionProfileName/Tags)', {
    cacheable: true }),
  'actor.inspect_components': read('read component-level values back from an actor or a blueprint CDO, with dotted property paths', {
    cacheable: true,
    warning: 'takes targets OR blueprint_path; a name that matched nothing is a 400 here, unlike actor.get which answers 200 with an empty list' }),
  'actor.set_property': write('set properties, with the special-cases routed through their real setters (ActorLabel, Tags, Mobility, SimulatePhysics, FolderPath, collision profile)', {
    warning: 'a misspelled property answers with suggestions rather than 404; read them instead of retrying the typo' }),
  'actor.set_transform': write('set / add / multiply location-rotation-scale, world or local space, optional snap-to-floor', {}),
  'actor.destroy': destroy('destroy every actor the selector matches', {
    warning: 'check unmatched_targets: a name that matched nothing is reported there rather than silently skipped' }),

  // ── level ──────────────────────────────────────────────────────────────────
  'level.get_current': read('the open level name and path', { cacheable: true }),
  'level.list': read('the levels in this project', { cacheable: true }),
  'level.new': danger('create a new level, optionally saving it', {
    warning: 'a map change clears the agent undo buffer in the plugin — a session rollback budget does not survive it' }),
  'level.open': danger('load a level', {
    ...long({}, 240_000),
    warning: 'the plugin clears both undo buffers before loading, so nothing done in this session is undoable afterwards' }),
  'level.save': danger('save the current level to disk', { warning: 'outlives the session; auto-rollback cannot undo a save' }),
  'level.set_streaming': write('change a sublevel streaming setting', {}),
  'level.organize_actors': write('move actors into outliner folders', {}),
  'level.query_assets': read('asset usage inside the current level', { cacheable: true }),

  // ── editor / viewport / PIE ────────────────────────────────────────────────
  'editor.get_dirty': read('dirty packages, split into agent-touched and everything else', { cacheable: true }),
  'editor.save': danger('save packages to disk', {
    warning: 'scope "touched" (default) saves only what agent commands dirtied; "all" also saves the user\u2019s own edits' }),
  'editor.screenshot': read('capture the viewport (or the game world during PIE) to a PNG on disk', {
    ...long({}, 120_000),
    warning: 'the result is a file path, not an image; pending_shaders / pending_assets / streaming_in_flight nonzero means the picture is not the finished look — use ual_screenshot to get the image itself' }),
  'editor.capture_app_window': read('capture a whole editor window to a PNG (fronts the window, so it can disturb what the user is doing)', {
    timeoutMs: 60_000,
    warning: 'needs the window visible; returns a path, not an image' }),
  'editor.get_focus_context': read('which asset editors are open, which has focus, and what is selected in it', { cacheable: true }),
  'editor.collect_garbage': write('force a garbage collection', { warning: 'a GC pass stalls the game thread; never during a PIE measurement' }),
  'editor.restart': danger('restart the editor', {
    warning: 'the 200 is sent and then the process dies: unsaved work is lost and the socket drops. Never in an auto-retry path.' }),
  'editor.quit': danger('close the editor', {
    warning: 'the 200 is sent and then the process dies: unsaved work is lost. Never in an auto-retry path.' }),
  'editor.undo': write('undo steps on the AGENT\u2019S OWN transaction buffer (the user\u2019s Ctrl+Z history is untouched)', {
    warning: 'steps<=0 undoes everything on that buffer; read affected_packages / affected_objects — a level switch can make the restore a no-op' }),
  'editor.redo': write('redo steps on the agent buffer'),
  'editor.undo_history': read('the agent buffer\u2019s remaining steps with the packages and objects each touched'),
  'viewport.focus': write('frame the viewport on actors, a region, or a direction', long({}, 60_000)),
  'pie.run': write('run a timed PIE playtest and report what happened (errors, actor deltas, optional screenshots)', {
    ...long({}, 300_000),
    warning: 'blocks the game thread for duration_seconds plus up to 15 s of startup and teardown — run it through ual_task' }),
  'pie.stop': write('end a running PIE session'),
  'pie.observe': read('sense the live PIE world: pawn, targets, widgets, sensors, recent logs', { cacheable: true }),
  'pie.plan_path': read('plan a navigation path', { cacheable: true }),
  'pie.nav_path': read('walk a navigation path', { cacheable: true }),
  'pie.scene': read('the PIE scene summary', { cacheable: true }),
  'pie.move_to': write('drive the pawn to a location', long({}, 120_000)),
  'pie.move_stop': write('stop the pawn'),
  'pie.set_view': write('set the PIE player camera, including cinematic override', {}),
  'pie.click_widget': write('click a UMG widget', {
    warning: 'answers 409 while PIE is running: the hit test needs a tick the blocked game thread will not give' }),

  // ── content / assets ───────────────────────────────────────────────────────
  'content.search': read('search the asset registry by name, class, path, folder, tag', {
    cacheable: true,
    warning: REGISTRY_NOTE }),
  'content.describe': read('describe one asset — size, bounds, LODs, materials, dependencies and referencers', {
    cacheable: true,
    warning: 'this method takes "path", while the material and blueprint families take "asset_path"/"blueprint_path" — ual_schema lists the exact keys' }),
  'content.dependencies': read('an asset\u2019s dependency edges', { cacheable: true, warning: REGISTRY_NOTE }),
  'content.asset_ranking': read('assets ranked by how much references them', { cacheable: true, warning: REGISTRY_NOTE }),
  'content.size_map': read('directory byte sizes', { cacheable: true }),
  'content.naming_audit': read('naming-convention violations', { cacheable: true }),
  'content.audit_optimization': read('optimization audit over a set of assets', long({}, 300_000)),
  'content.registry_status': read('whether the asset registry is ready and how far the scan got — cheap, never blocks'),
  'content.registry_scan': write('register specific files into the asset registry without a full scan', {}),
  'content.import': write('import a file from disk into the project', {
    ...long({}, 300_000),
    warning: 'Interchange holds the game thread for minutes on a heavy mesh' }),
  'content.normalized_import': write('import through the normalization pipeline', { ...long({}, 300_000) }),
  'content.delete': destroy('delete assets', {
    warning: 'fails while the agent undo buffer still references the asset; drop_agent_undo discards those steps — read the failed list rather than assuming success' }),
  'content.move': write('move or rename one asset', {}),
  'content.batch_move': write('move many assets, reporting collisions and redirectors', {}),
  'content.fixup_redirectors': write('resolve redirectors in place', long({}, 180_000)),
  'content.migrate': danger('migrate assets into this project from another', { warning: 'reads another project on disk and writes this one' }),

  // ── blueprints ─────────────────────────────────────────────────────────────
  'blueprint.create': write('create a blueprint asset', {
    warning: 'takes parent_class with a parentClass fallback; the blueprint_require_empty capability means an existing target is a 409, not an overwrite' }),
  'blueprint.describe': read('a blueprint\u2019s variables, components, graphs, and event list', { cacheable: true }),
  'blueprint.compile': write('compile one blueprint', {
    ...long({}, 180_000),
    warning: 'diagnostics arrive structured (type/severity/node_id/pin) — surface them rather than re-parsing the message' }),
  'blueprint.compile_all': write('compile every loaded blueprint', {
    ...long({}, 900_000),
    warning: 'minutes, single-threaded, on the game thread' }),
  'blueprint.add_variable': write('add a variable', {}),
  'blueprint.remove_variable': write('remove a variable', {}),
  'blueprint.set_variable_meta': write('set variable metadata', {}),
  'blueprint.add_component': write('add a component to a blueprint', {}),
  'blueprint.set_parent_class': write('change the parent class', {
    warning: 'this can invalidate nodes; compile afterwards and read the diagnostics' }),
  'blueprint.set_property': write('set class-default properties on the blueprint\u2019s CDO', {}),
  'blueprint.create_graph': write('add a graph', {}),
  'blueprint.create_function': write('add a function graph', {}),
  'blueprint.create_event_graph': write('add an event graph', {}),
  'blueprint.function_signature': write('declare a function\u2019s inputs and outputs', {}),
  'blueprint.list_graphs': read('a blueprint\u2019s graphs', { cacheable: true }),
  'blueprint.get_graph': read('one graph as nodes and wires', {
    cacheable: true,
    warning: 'a large graph is truncated with a note, not silently — read the note before concluding a node is missing' }),
  'blueprint.search_nodes': read('find nodes by title/class in a graph', { cacheable: true }),
  'blueprint.delete_node': write('delete nodes', {}),
  'blueprint.disconnect_pins': write('cut wires between pins', {}),
  'blueprint.set_node_positions': write('move many nodes at once', {}),
  'blueprint.set_comment': write('set a graph comment', {}),
  'blueprint.event_dispatcher': write('add an event dispatcher', {}),
  'blueprint.component_event': write('add a component event binding', {}),
  'blueprint.export_t3d': write('export a graph or asset as T3D text', {}),
  'blueprint.import_t3d': danger('paste T3D text into a blueprint', {
    warning: 'a pasted blob can break the asset; the plugin removes ghost event nodes for you and reports it in removed_ghost_events' }),

  // ── materials ──────────────────────────────────────────────────────────────
  'material.create': write('create a material asset', {}),
  'material.create_instance': write('create a material instance', {}),
  'material.create_function': write('create a material function', {}),
  'material.describe': read('a material\u2019s parameters, blend mode, and node summary', { cacheable: true }),
  'material.get_graph': read('a material expression graph', { cacheable: true }),
  'material.search_nodes': read('find material nodes', { cacheable: true }),
  'material.get_referencers': read('what references this material', { cacheable: true }),
  'material.add_node': write('add an expression node', {}),
  'material.delete_node': write('delete expression nodes', {}),
  'material.delete_unused_nodes': write('prune unconnected nodes', {}),
  'material.connect_pins': write('wire expression pins', {}),
  'material.disconnect_pins': write('cut expression wires', {}),
  'material.set_node_value': write('set an expression\u2019s value', {}),
  'material.set_node_positions': write('move expression nodes', {}),
  'material.set_property': write('set a material property (blend mode, domain, flags)', {}),
  'material.set_param': write('set static-switch / vector / scalar parameters on an instance', {}),
  'material.compile': write('compile a material', { ...long({}, 120_000) }),
  'material.apply': write('apply a material to actor mesh slots', {}),
  'material.duplicate': write('duplicate a material', {}),
  'material.parameter_collection': write('create or edit a parameter collection', {}),

  // ── widgets / UMG ──────────────────────────────────────────────────────────
  'widget.create': write('create a widget blueprint', {}),
  'widget.get_hierarchy': read('a widget tree with slot info', { cacheable: true }),
  'widget.add_child': write('add a child widget', {}),
  'widget.set_property': write('set a widget property', {}),
  'widget.set_canvas_slot': write('position a canvas slot', {}),
  'widget.set_vertical_slot': write('set a vertical-box slot', {}),
  'widget.make_variable': write('expose a widget as a blueprint variable', {}),
  'widget.preview': read('render a widget preview', { timeoutMs: 60_000, warning: 'returns a file path, not an image' }),

  // ── sequences / rendering ─────────────────────────────────────────────────
  'sequence.describe': read('a Level Sequence\u2019s tracks and bindings', { cacheable: true }),
  'sequence.diff': read('compare two Level Sequences semantically: tracks, bindings, camera coverage', { cacheable: true }),
  'sequence.audit': read('audit a sequence for binding and track problems', { ...long({}, 120_000) }),
  'sequence.rebind': write('rebind sequence tracks to different actors', {}),
  'sequence.camera_keys': read('a camera cut\u2019s keyframes', { cacheable: true }),
  'sequence.camera_cuts': read('the camera-cut list for a sequence', { cacheable: true }),
  'sequence.render': write('render a sequence with Movie Render Queue', {
    ...long({}, 1_800_000),
    warning: 'blocks the game thread for the whole render and replies only at the end; the returned job_id is a key for sequence.render_status, which cannot be served until the render finishes. Use ual_task.' }),
  'sequence.render_status': read('the progress of a render job', { cacheable: true }),
  'sequence.render_cancel': write('cancel a render job'),

  // ── PCG ────────────────────────────────────────────────────────────────────
  'pcg.status': read('whether the PCG plugin is usable in this project', { cacheable: true }),
  'pcg.create_graph': write('create a PCG graph asset', {}),
  'pcg.get_graph': read('a PCG graph', { cacheable: true }),
  'pcg.list_node_types': read('available PCG node types', { cacheable: true }),
  'pcg.get_node_schema': read('one node type\u2019s parameter schema', { cacheable: true }),
  'pcg.describe_node': read('describe one graph node', { cacheable: true }),
  'pcg.add_node': write('add a node', {}),
  'pcg.update_node': write('update a node', {}),
  'pcg.remove_node': write('remove a node', {}),
  'pcg.connect_pins': write('wire PCG nodes', {}),
  'pcg.disconnect_pins': write('cut PCG wires', {}),
  'pcg.set_node_positions': write('move PCG nodes', {}),
  'pcg.graph_parameters': write('set graph-level parameters', {}),
  'pcg.spawn_volume': write('spawn a PCG volume', {}),
  'pcg.apply_graph': write('apply a graph to a volume', {}),
  'pcg.execute': write('execute PCG generation for volumes', {
    ...long({}, 900_000),
    warning: 'minutes of blocked game thread on a large volume' }),
  'pcg.diagnose': read('diagnose why a graph produced nothing', long({}, 120_000)),
  'pcg.scene_report': read('every PCG component in the level and its state', long({}, 120_000)),

  // ── landscape / mesh / animation ──────────────────────────────────────────
  'landscape.create': write('create a landscape', {}),
  'landscape.list': read('the landscapes in this level', { cacheable: true }),
  'landscape.setup_rvt': write('set up Runtime Virtual Texture for a landscape', long({}, 180_000)),
  'mesh.describe': read('a mesh asset\u2019s statistics', { cacheable: true }),
  'datatable.describe': read('a DataTable\u2019s rows and struct', { cacheable: true }),
  'datatable.edit': write('edit DataTable rows', {}),

  // ── input ──────────────────────────────────────────────────────────────────
  // `input.map` delegates to Handle_GetInputMap: it READS the binding setup. It
  // was classified as a write in the first draft, which would have pushed a
  // harmless query through the approval gate on every call.
  'input.map': read('the enabled input bindings, actions, and mapping contexts', { cacheable: true }),
  'input.add_mapping': write('add a key mapping to an input action / mapping context'),
  'input.inject_key': write('inject a raw key event into the editor', {
    warning: 'answers 409 while PIE is running and suggests pie.* instead' }),
  'input.inject_action': write('inject an action event'),

  // ── logs ───────────────────────────────────────────────────────────────────
  'messagelog.list': read('the editor Message Log (pull only — the push events were removed upstream)', { cacheable: true }),
  'messagelog.get': read('one Message Log entry'),

  // ── animation: UE 5.5+ only ───────────────────────────────────────────────
  'anim.measure': read('measure bone trajectories and root motion over an animation', {
    warning: 'requires UE 5.5 or later; on an older editor every anim.* command answers 501' }),
  'anim.write_pose': write('write pose data into an animation asset and save it', {
    warning: 'requires UE 5.5+; this overwrites animation keys' }),
  'anim.preview': read('preview an animation retarget on a target skeleton', {
    warning: 'requires UE 5.5+' }),
  'anim.retarget': write('retarget an animation onto another skeleton', {
    warning: 'requires UE 5.5+' }),

  // ── C++ toolchain: the highest-risk family ────────────────────────────────
  'cpp.list_modules': read('the project\u2019s C++ modules', { cacheable: true }),
  'cpp.probe': read('check whether a class or header exists before generating anything', { cacheable: true }),
  'cpp.add_class': write('generate a new C++ class', {
    warning: 'OMIT "abstract" rather than sending null — the plugin reads it without a null check and the editor crashes' }),
  'cpp.compile': danger('build the C++ project and restart the editor', {
    ...long({}, 1_800_000),
    warning: 'minutes of build, then the editor restarts and the socket drops. Use ual_task and expect to reconnect.' }),

  // ── Python escape hatch ───────────────────────────────────────────────────
  'cmd.run_python': danger('run arbitrary editor Python (editor or game context)', {
    warning: 'this bypasses every risk classification in this catalog: anything an actor/material command could do, and anything it cannot' }),

  // ── state push, not a command (see sessions/scope.ts) ─────────────────────
  'locks.set': write('replace the whole asset-lock table the editor draws badges from', {
    warning: 'the enforced subset has its files marked READ-ONLY on disk and engine Save All silently skips them — never send enforced unless the caller asked for it' }) }

/** Methods refused with an explanation, because they do not exist or are dead. */
export const BLACKLIST: Readonly<Record<string, string>> = {
  'content.get_referencers':
    'registered into the wrong map upstream, so it answers 404 always. Use material.get_referencers, or content.describe with include_referencers:true.',
  'editor.play': 'dead alias, 404 always. Use pie.run.',
  'editor.stop': 'dead alias, 404 always. Use pie.stop.',
  take_screenshot: 'removed upstream 2026-09-16. Use editor.screenshot.',
  actor_destroy_batch: 'removed upstream 2026-09-16. Use actor.destroy with targets.names/paths.',
  'actor.destroy_batch': 'removed upstream 2026-09-16. Use actor.destroy with targets.names/paths.',
  'messagelog.subscribe': 'removed upstream 2026-09-16 — log access is pull-only. Use messagelog.list, or ual_logs for this bridge\u2019s ring.',
  'messagelog.unsubscribe': 'removed upstream 2026-09-16.',
  'log.subscribe': 'not a UAL method. The editor pushes log.entry when the cvar ual.ForwardLogs is 1; ual_logs reads the ring.',
  cancel_task:
    'UnrealAgentLink has no task cancellation of any kind. ual_task stops the bridge from waiting; the engine-side work keeps running on the game thread.',
  query_task:
    'UnrealAgentLink has no task polling. sequence.render_status and content.registry_status are the only progress endpoints, and both need the game thread to be free.' }

const KNOWN = new Set<string>(UAL_REGISTERED_METHODS)

/** Every cataloged method name. */
export const METHOD_NAMES: readonly string[] = Object.keys(METHODS)

/** Catalog names that are not registered upstream — a test asserts this stays empty. */
export const CATALOG_DRIFT: readonly string[] = METHOD_NAMES.filter(name => !KNOWN.has(name))

/**
 * Own-property lookup into a plain-object table.
 *
 * Every table in this module is an object literal, so `TABLE[method]` reaches
 * `Object.prototype` for names like `toString`, `constructor` or `valueOf`.
 * That is not theoretical: the tool arguments are model-supplied, and an
 * unguarded `PARAM_KEYS['toString']` hands back a *function*, which then blows
 * up inside the spread that builds `ual_schema`'s parameter list.
 */
function own<T>(table: Record<string, T>, method: string): T | undefined {
  return Object.hasOwn(table, method) ? table[method] : undefined
}

export function specOf(method: string): MethodSpec | undefined {
  return own(METHODS, method)
}

export function riskOf(method: string): Risk {
  return own(METHODS, method)?.risk ?? 'dangerous'
}

/** Unknown is mutating: the bridge records and asks rather than assuming reads. */
export function isMutating(method: string): boolean {
  return own(METHODS, method)?.risk !== 'read'
}

export function cacheable(method: string): boolean {
  return own(METHODS, method)?.cacheable === true
}

/**
 * The keys a call cannot omit, from the plugin's OWN `SendError(…, 400,
 * "Missing field: X")` messages, plus any hand-written `requires` on the row.
 *
 * This is what `service.call()` gates on. It is deliberately generous about what
 * it will let through: the generated table only records a key when the handler
 * refuses without it, so a key that is merely *read* (or that one branch of a
 * handler needs) is never asserted here. A false positive rejects a valid call
 * before the engine can answer it, which is strictly worse than a 400 — the model
 * then sees our invented requirement instead of the handler's real complaint.
 */
export function requiresOf(method: string): readonly string[] {
  const hand = own(METHODS, method)?.requires
  const derived = own(REQUIRED_KEYS, method) ?? []
  if (!hand || hand.length === 0) return derived
  return [...new Set([...hand, ...derived])]
}

/** Whether the method is known to the catalog and registered upstream. */
export function isKnown(method: string): boolean {
  return Object.hasOwn(METHODS, method) && KNOWN.has(method)
}

/**
 * The timeout floor for one method: an explicit override always wins, then the
 * catalog's per-method number, then the configured default. Blocking commands get
 * their generous figure here rather than at each call site, so a caller cannot
 * hand `sequence.render` 30 s and conclude the editor died.
 */
export function timeoutFor(method: string, configured: number, override?: number): number {
  if (override !== undefined) return override
  const floor = own(METHODS, method)?.timeoutMs
  if (floor === undefined) return configured
  return Math.max(configured, floor)
}

/** The keys a handler reads, for early `requires` rejection and for `ual_schema`. */
export function paramKeysOf(method: string): readonly string[] {
  const derived = own(PARAM_KEYS, method) ?? []
  // Four rows reach their params through a file-local helper or a
  // namespace-qualified function pointer, which the extractor cannot bind; they
  // are marked `PARAMS_UNRESOLVED` and read by hand into EXTRA_PARAM_KEYS. Merging
  // here rather than at each call site keeps `ual_schema`, the `requires` check
  // and the error hints answering from one place.
  const extra = own(EXTRA_PARAM_KEYS, method)
  if (!extra || extra.length === 0) return derived
  return [...new Set([...derived, ...extra])]
}

export function codesOf(method: string): readonly number[] {
  return own(METHOD_CODES, method) ?? []
}
