/**
 * Hand-verified additions to the machine-extracted method table.
 *
 * `scripts/extract-methods.mjs` resolves a handler by name inside its own file.
 * It deliberately does not follow a call into *another* translation unit, because
 * `FUAL_AgentUndo::Undo` and `::Redo` live in one file and following both would
 * merge two methods' shapes into one. The handful of builders that genuinely
 * assemble a response across files are recorded here, each with the source line
 * it came from, so a wrong entry is reviewable rather than silently plausible.
 *
 * @module catalog/method-overrides
 */

/**
 * `FUAL_EditorHealth::BuildReport` (`Private/Utils/UAL_EditorHealth.cpp`).
 * Unavailable numbers are written as real JSON `null`, not 0 — `startup_seconds`
 * is null on an editor that started before the collector attached.
 */
export const EDITOR_HEALTH_KEYS = [
  'ok',
  'collector_started_at_seconds',
  'startup_seconds',
  'asset_registry_seconds',
  'asset_registry_done_before_collector',
  'enabled_plugin_count',
  'editor_hitch_pct',
  'editor_hitch_samples',
  'pie_hitch_pct',
  'pie_hitch_samples',
  'pie_first_enter_seconds',
  'pie_last_enter_seconds',
  'pie_enter_count',
  'ddc_supported',
  'local_ddc_hit_pct',
  'local_ddc_lookups',
  'available_memory_gb',
  'total_memory_gb',
] as const

/** `FUAL_RegistryReady::StatusJson` — also the `details` of a 503 registry_not_ready. */
export const REGISTRY_STATUS_KEYS = [
  'ok',
  'ready',
  'criterion',
  'search_all_assets',
  'progress',
  'note',
] as const

export const REGISTRY_PROGRESS_KEYS = [
  'total',
  'processed',
  'pending_data_load',
  'discovering_files',
  'snapshot_age_ms',
  'has_snapshot',
] as const

/**
 * `system.get_performance_stats` (`Private/Commands/UAL_SystemCommands.cpp`).
 * Note the documented trap: `render_thread_ms` is 0 on some machines regardless
 * of activity, so it is **not** evidence that the editor is idle.
 */
export const PERFORMANCE_STATS_KEYS = ['fps', 'frame_ms', 'game_thread_ms', 'render_thread_ms', 'rhi_thread_ms', 'gpu_ms'] as const

/**
 * `system.get_project_info`'s `capabilities` sub-object. A missing key must be
 * read as **unsupported**: older plugin builds in user projects do not declare
 * what they cannot do, and the header comment in the plugin says so explicitly.
 */
export const CAPABILITY_KEYS = ['blueprint_require_empty', 'material_fail_if_exists', 'python'] as const

/**
 * `editor.screenshot` / `editor.capture_app_window` result shape.
 *
 * This is the one that the plugin's own markdown gets wrong. `Resources/Docs/
 * 编辑器工具接口文档.md` documents a base64 `image` field; the handler writes a
 * **file path** (`Data->SetStringField(TEXT("path"), CapturedPath)`) and there is
 * no base64 anywhere in the capture path. The bridge therefore reads the file
 * from disk — it is on this machine, since UE and the bridge are local — and does
 * not trust the doc.
 */
export const SCREENSHOT_KEYS = [
  'path',
  'filename',
  'width',
  'height',
  'saved',
  'method',
  'world',
  'view',
  'restore_app_window',
  'pending_assets',
  'pending_shaders',
  'streaming_in_flight',
  'warmup_frames',
  'wait_ms',
  'camera_source',
  'exposure',
  'exposure_source',
  'camera_location',
  'camera_rotation',
] as const

export const CAPTURE_APP_WINDOW_KEYS = ['path', 'filename', 'width', 'height', 'saved', 'window_title', 'window_source'] as const

/** method -> keys the extractor could not see because they are built cross-file. */
export const EXTRA_RESULT_KEYS: Readonly<Record<string, readonly string[]>> = {
  'system.get_editor_health': EDITOR_HEALTH_KEYS,
  'content.registry_status': REGISTRY_STATUS_KEYS,
  'system.get_performance_stats': PERFORMANCE_STATS_KEYS,
  'editor.screenshot': SCREENSHOT_KEYS,
  'editor.capture_app_window': CAPTURE_APP_WINDOW_KEYS,
}

/**
 * Parameters for the four methods in `PARAMS_UNRESOLVED`, read by hand from the
 * handler bodies the extractor could not bind.
 *
 * The generator marks these rather than guessing: all four reach their params
 * through a file-local helper or a namespace-qualified function pointer whose
 * definition line does not match the extractor's prototype test. Each list below
 * was read off the accessor calls in the source — `actor.inspect_components` from
 * `Strings(Payload, TEXT("components"))` / `TryGetObjectField(TEXT("targets"))` in
 * `UAL_ComponentInspectCommands.cpp:292-330`, `sequence.diff` from the `base_path`
 * / `compare_path` / `binding_map` / `bindings` reads in
 * `UAL_SequenceDiffCommands.cpp:609-727`, and the two animation rows from
 * `LoadAnimation(Input, TEXT("path"))` plus the shared `MeasureSequence` reads in
 * `UAL_ZAnimationCommands.cpp`.
 */
export const EXTRA_PARAM_KEYS: Readonly<Record<string, readonly string[]>> = {
  'actor.inspect_components': ['blueprint_path', 'components', 'object_properties', 'properties', 'render_state', 'targets'],
  'anim.preview': ['bone_map', 'describe', 'path'],
  'anim.retarget': ['bone_map', 'describe', 'path', 'source'],
  'sequence.diff': ['base_path', 'binding_map', 'bindings', 'compare_path'],
}

/** Nested objects worth naming for the model, so `ual_schema` can show them. */
export const NESTED_SHAPES: Readonly<Record<string, { readonly parent: string; readonly keys: readonly string[] }>> = {
  registry_progress: { parent: 'content.registry_status', keys: REGISTRY_PROGRESS_KEYS },
  capabilities: { parent: 'system.get_project_info', keys: CAPABILITY_KEYS },
}
