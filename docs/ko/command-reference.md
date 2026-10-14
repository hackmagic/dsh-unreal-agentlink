<div align="center">

[English](../command-reference.md) · [简体中文](../zh/command-reference.md) · [繁體中文](../zh-TW/command-reference.md) · [日本語](../ja/command-reference.md) · **한국어** · [Deutsch](../de/command-reference.md) · [Español](../es/command-reference.md) · [Français](../fr/command-reference.md) · [Русский](../ru/command-reference.md)

[README](../readme/README_ko.md)

</div>

# 명령 참조

> **이 파일은 `node scripts/gen-docs.mjs`가 `src/catalog/`에서 생성합니다. 직접 편집하지 마세요.**
> 카탈로그 자체도 C++에서 추출한 것입니다(`scripts/extract-methods.mjs`). 손으로 쓴 세 번째 사본은
> 아무도 다시 확인하지 않는 낡은 문서가 될 뿐입니다. 변경하려면 생성기를 고치고
> `npm run build && node scripts/gen-docs.mjs`를 다시 실행하세요.

- 등록된 명령 **170**개, **22**개 계열
- 위험 등급: read 65 / write 89 / destructive 2 / dangerous 14
- 카탈로그 드리프트: 없음 (C++ 레지스트리와 항목별로 대조합니다. `scripts/check-catalog.mjs` 참고)

파라미터 열은 핸들러가 **실제로 읽는** 키(`PARAM_KEYS`)이고, 필수 열은 값이 없을 때
**스스로 거부하는** 키(`REQUIRED_KEYS`. 핸들러 자신의 `SendError(..., 400, "Missing field: X")`
메시지에서 도출)입니다. 둘 다 `scripts/extract-methods.mjs`가 C++에서 추출하며, `PARAMS_UNRESOLVED`인
4개 메서드는 `method-overrides.ts`의 `EXTRA_PARAM_KEYS`로 채웁니다.

명령 이름, 키 이름, 상태 코드는 C++에서 그대로 추출한 식별자이며 **번역하지 않습니다**.
UE는 모르는 키를 조용히 무시하므로 그대로 복사하세요.

## 위험 등급

| 등급 | 의미 | 승인 |
|---|---|---|
| `read` | 읽기 전용 조회. 동시 실행 가능, 읽기 캐시 대상 | 그대로 허용 |
| `write` | 에디터 상태를 변경. 되돌릴 수 있음 | 그대로 허용 |
| `destructive` | 삭제 계열 작업. **되돌리기로 완전히 복구되지 않을 수 있음** | `ask` |
| `dangerous` | 에디터 종료·재시작, `.ini` 쓰기, C++ 빌드, 임의 코드 실행 | `ask` |

`destructive` + `dangerous`는 모두 16개이며 `tools/pre-execute`가 `{kind:"ask"}`를 반환합니다. 등록되지 않은 메서드는 즉시 `deny`되고 에디터로 전달되지 않습니다.

## 계열 색인

| 계열 | 명령 수 | read | write | destructive | dangerous |
|---|---:|---:|---:|---:|---:|
| `actor` | 8 | 4 | 3 | 1 | 0 |
| `anim` | 4 | 2 | 2 | 0 | 0 |
| `blueprint` | 25 | 4 | 20 | 0 | 1 |
| `cmd` | 1 | 0 | 0 | 0 | 1 |
| `content` | 16 | 8 | 6 | 1 | 1 |
| `cpp` | 4 | 2 | 1 | 0 | 1 |
| `datatable` | 2 | 1 | 1 | 0 | 0 |
| `editor` | 12 | 6 | 3 | 0 | 3 |
| `input` | 4 | 1 | 3 | 0 | 0 |
| `landscape` | 3 | 1 | 2 | 0 | 0 |
| `level` | 8 | 3 | 2 | 0 | 3 |
| `locks` | 1 | 0 | 1 | 0 | 0 |
| `material` | 20 | 4 | 16 | 0 | 0 |
| `mesh` | 1 | 1 | 0 | 0 | 0 |
| `messagelog` | 2 | 2 | 0 | 0 | 0 |
| `pcg` | 18 | 7 | 11 | 0 | 0 |
| `pie` | 10 | 4 | 6 | 0 | 0 |
| `project` | 6 | 4 | 0 | 0 | 2 |
| `sequence` | 9 | 6 | 3 | 0 | 0 |
| `system` | 7 | 3 | 2 | 0 | 2 |
| `viewport` | 1 | 0 | 1 | 0 | 0 |
| `widget` | 8 | 2 | 6 | 0 | 0 |

## 명령 목록

### `actor` (8)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `actor.destroy` | **destructive** | `name` `path` `targets` | — | 기본 | destroy every actor the selector matches<br>⚠️ check unmatched_targets: a name that matched nothing is reported there rather than silently skipped |
| `actor.get` | read | `name` `path` `targets` | — | 기본 | list actors, by name/path or a targets selector |
| `actor.get_info` | read | `include_system_actors` `limit` `return_bounds` `return_transform` `targets` | — | 기본 | the unified selector query, with transform/bounds options and system-actor accounting |
| `actor.inspect` | read | `include_system_actors` `properties` `targets` | — | 기본 | read a bounded property set off selected actors (default whitelist Mobility/bHidden/CollisionProfileName/Tags) |
| `actor.inspect_components` | read | `blueprint_path` `components` `object_properties` `properties` `render_state` `targets` | — | 기본 | read component-level values back from an actor or a blueprint CDO, with dotted property paths<br>⚠️ takes targets OR blueprint_path; a name that matched nothing is a 400 here, unlike actor.get which answers 200 with an empty list |
| `actor.set_property` | write | `add` `error` `properties` `remove` `targets` | — | 기본 | set properties, with the special-cases routed through their real setters (ActorLabel, Tags, Mobility, SimulatePhysics, FolderPath, collision profile)<br>⚠️ a misspelled property answers with suggestions rather than 404; read them instead of retrying the typo |
| `actor.set_transform` | write | `operation` `reason` `snap_to_floor` `space` `targets` | — | 기본 | set / add / multiply location-rotation-scale, world or local space, optional snap-to-floor |
| `actor.spawn` | write | `asset_id` `batch` `class` `instances` `mesh` `name` `path` `preset` `reason` | — | 기본 | spawn one or many actors from asset_id aliases, asset paths, or class names<br>⚠️ batch is capped by the ual.MaxBatchCreate cvar (default 50); an over-cap request returns 413 |

### `anim` (4)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `anim.measure` | read | `path` | — | 기본 | measure bone trajectories and root motion over an animation<br>⚠️ requires UE 5.5 or later; on an older editor every anim.* command answers 501 |
| `anim.preview` | read | `bone_map` `describe` `path` | — | 기본 | preview an animation retarget on a target skeleton<br>⚠️ requires UE 5.5+ |
| `anim.retarget` | write | `bone_map` `describe` `path` `source` | — | 기본 | retarget an animation onto another skeleton<br>⚠️ requires UE 5.5+ |
| `anim.write_pose` | write | `path` `source` | — | 기본 | write pose data into an animation asset and save it<br>⚠️ requires UE 5.5+; this overwrites animation keys |

### `blueprint` (25)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `blueprint.add_component` | write | `attach_to` `blueprint_name` `component_name` `component_properties` `component_type` | — | 기본 | add a component to a blueprint |
| `blueprint.add_variable` | write | `blueprint_path` `container` `default_value` `is_array` `name` `object_class` `type` | — | 기본 | add a variable |
| `blueprint.compile` | write | `blueprint_path` `save` | — | 180초 차단 | compile one blueprint<br>⚠️ diagnostics arrive structured (type/severity/node_id/pin) — surface them rather than re-parsing the message |
| `blueprint.compile_all` | write | `limit` `path` `scope` | — | 900초 차단 | compile every loaded blueprint<br>⚠️ minutes, single-threaded, on the game thread |
| `blueprint.component_event` | write | `action` `blueprint_path` `component_name` `event_name` `graph_name` | — | 기본 | add a component event binding |
| `blueprint.create` | write | `attach_to` `component_name` `component_type` `components` `folder` `name` `parentClass` `parent_class` `path` `properties` `skeleton` | `name` | 기본 | create a blueprint asset<br>⚠️ takes parent_class with a parentClass fallback; the blueprint_require_empty capability means an existing target is a 409, not an overwrite |
| `blueprint.create_event_graph` | write | `blueprint_path` `graph_name` | — | 기본 | add an event graph |
| `blueprint.create_function` | write | `blueprint_path` `function_name` `inputs` `outputs` `pure` | — | 기본 | add a function graph |
| `blueprint.create_graph` | write | `arrive_tangent` `autoplay` `blueprint_path` `class` `clear_existing` `compile` `connections` `first_index` `from` `graph_name` `id` `inputs` `interp` `keys` `last_index` `leave_tangent` `length` `length_mode` `loop` `macro_lib` `member_name` `name` `nodes` `params` `pin_defaults` `position` `raw_class` `reliable` `replication` `require_empty` `settings` `struct_type` `target_class` `time` `timeline` `to` `tracks` `type` `value` `x` `y` | — | 기본 | add a graph |
| `blueprint.delete_node` | write | `blueprint_path` `graph_name` `node_id` | `blueprint_path` `node_id` | 기본 | delete nodes |
| `blueprint.describe` | read | `blueprint_name` `blueprint_path` | — | 기본 | a blueprint’s variables, components, graphs, and event list |
| `blueprint.disconnect_pins` | write | `blueprint_path` `graph_name` `node_id` `other_node_id` `other_pin` `pin` | `blueprint_path` `node_id` `pin` | 기본 | cut wires between pins |
| `blueprint.event_dispatcher` | write | `action` `blueprint_path` `class` `name` `params` `type` | — | 기본 | add an event dispatcher |
| `blueprint.export_t3d` | write | `blueprint_path` `graph_name` `node_ids` | — | 기본 | export a graph or asset as T3D text |
| `blueprint.function_signature` | write | `action` `blueprint_path` `class` `direction` `graph_name` `name` `param` `type` | — | 기본 | declare a function’s inputs and outputs |
| `blueprint.get_graph` | read | `blueprint_name` `blueprint_path` `graph_name` `limit` `offset` | — | 기본 | one graph as nodes and wires<br>⚠️ a large graph is truncated with a note, not silently — read the note before concluding a node is missing |
| `blueprint.import_t3d` | **dangerous** | `blueprint_path` `compile` `graph_name` `offset_x` `offset_y` `require_empty` `text` | — | 기본 | paste T3D text into a blueprint<br>⚠️ a pasted blob can break the asset; the plugin removes ghost event nodes for you and reports it in removed_ghost_events |
| `blueprint.list_graphs` | read | `blueprint_name` `blueprint_path` | — | 기본 | a blueprint’s graphs |
| `blueprint.remove_variable` | write | `blueprint_path` `name` | — | 기본 | remove a variable |
| `blueprint.search_nodes` | read | `blueprint_path` `limit` `query` | — | 기본 | find nodes by title/class in a graph |
| `blueprint.set_comment` | write | `a` `b` `blueprint_path` `bounds` `color` `enclose_nodes` `font_size` `g` `graph_name` `height` `node_id` `r` `text` `width` `x` `y` | — | 기본 | set a graph comment |
| `blueprint.set_node_positions` | write | `blueprint_path` `graph_name` `node_id` `positions` `x` `y` | — | 기본 | move many nodes at once |
| `blueprint.set_parent_class` | write | `blueprint_path` `parent_class` | — | 기본 | change the parent class<br>⚠️ this can invalidate nodes; compile afterwards and read the diagnostics |
| `blueprint.set_property` | write | `auto_compile` `blueprint_path` `component_name` `properties` | — | 기본 | set class-default properties on the blueprint’s CDO |
| `blueprint.set_variable_meta` | write | `blueprint_path` `blueprint_read_only` `category` `expose_on_spawn` `instance_editable` `name` `replication` `tooltip` | — | 기본 | set variable metadata |

### `cmd` (1)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `cmd.run_python` | **dangerous** | `script` | `script` | 기본 | run arbitrary editor Python (editor or game context)<br>⚠️ this bypasses every risk classification in this catalog: anything an actor/material command could do, and anything it cannot |

### `content` (16)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `content.asset_ranking` | read | `class_filter` `limit` `path` `sort_by` | — | 기본 | assets ranked by how much references them<br>⚠️ while the initial asset-registry scan runs this answers 503 registry_not_ready with progress in details — poll content.registry_status; never pass on_registry_busy:"wait", which deadlocks the game thread |
| `content.audit_optimization` | read | `check_type` `path` | — | 300초 차단 | optimization audit over a set of assets |
| `content.batch_move` | write | `destination` `destination_folder` `dry_run` `fixup_redirectors` `folder_moves` `moves` `on_blocked` `on_cdo_refs` `on_conflict` `save` `source` `source_folder` | — | 기본 | move many assets, reporting collisions and redirectors |
| `content.delete` | **destructive** | `drop_agent_undo` `paths` | — | 기본 | delete assets<br>⚠️ fails while the agent undo buffer still references the asset; drop_agent_undo discards those steps — read the failed list rather than assuming success |
| `content.dependencies` | read | `direction` `hard_only` `include_edges` `include_engine` `limit` `max_depth` `max_nodes` `path` `recursive` | — | 기본 | an asset’s dependency edges<br>⚠️ while the initial asset-registry scan runs this answers 503 registry_not_ready with progress in details — poll content.registry_status; never pass on_registry_busy:"wait", which deadlocks the game thread |
| `content.describe` | read | `dependencies` `include_dependencies` `include_referencers` `path` `referencers` | — | 기본 | describe one asset — size, bounds, LODs, materials, dependencies and referencers<br>⚠️ this method takes "path", while the material and blueprint families take "asset_path"/"blueprint_path" — ual_schema lists the exact keys |
| `content.fixup_redirectors` | write | `delete_broken` `dry_run` `path` `paths` | — | 180초 차단 | resolve redirectors in place |
| `content.import` | write | `anim_frame_rate` `destination_path` `fbx_import_as` `files` `normalized` `normalized_names` `original` `overwrite` `path` `scale` `skeleton` | — | 300초 차단 | import a file from disk into the project<br>⚠️ Interchange holds the game thread for minutes on a heavy mesh |
| `content.migrate` | **dangerous** | `destination` `dry_run` `include_dependencies` `on_conflict` `save_first` | — | 기본 | migrate assets into this project from another<br>⚠️ reads another project on disk and writes this one |
| `content.move` | write | `auto_rename` `destination_path` `source_path` | — | 기본 | move or rename one asset |
| `content.naming_audit` | read | `class_filter` `include_compliant` `limit` `pascal_case` `path` `recursive` `rules` | — | 기본 | naming-convention violations |
| `content.normalized_import` | write | `auto_rename_on_conflict` `files` `target_root` `use_pascal_case` `use_semantic_suffix` | — | 300초 차단 | import through the normalization pipeline |
| `content.registry_scan` | write | `files` `force` `paths` | — | 기본 | register specific files into the asset registry without a full scan |
| `content.registry_status` | read | — | — | 기본 | whether the asset registry is ready and how far the scan got — cheap, never blocks |
| `content.search` | read | `filter_class` `include_folders` `limit` `path` `query` | — | 기본 | search the asset registry by name, class, path, folder, tag<br>⚠️ while the initial asset-registry scan runs this answers 503 registry_not_ready with progress in details — poll content.registry_status; never pass on_registry_busy:"wait", which deadlocks the game thread |
| `content.size_map` | read | `max_nodes` `path` | — | 기본 | directory byte sizes |

### `cpp` (4)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `cpp.add_class` | write | `location` `module` `name` `parent_class` | — | 기본 | generate a new C++ class<br>⚠️ OMIT "abstract" rather than sending null — the plugin reads it without a null check and the editor crashes |
| `cpp.compile` | **dangerous** | — | — | 1800초 차단 | build the C++ project and restart the editor<br>⚠️ minutes of build, then the editor restarts and the socket drops. Use ual_task and expect to reconnect. |
| `cpp.list_modules` | read | `include_plugins` | — | 기본 | the project’s C++ modules |
| `cpp.probe` | read | — | — | 기본 | check whether a class or header exists before generating anything |

### `datatable` (2)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `datatable.describe` | read | `asset_path` `columns` `limit` `offset` `rows` | — | 기본 | a DataTable’s rows and struct |
| `datatable.edit` | write | `asset_path` `copy_from` `new_name` `op` `ops` `row` `values` | — | 기본 | edit DataTable rows |

### `editor` (12)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `editor.capture_app_window` | read | `filepath` `window` | — | 기본 | capture a whole editor window to a PNG (fronts the window, so it can disturb what the user is doing)<br>⚠️ needs the window visible; returns a path, not an image |
| `editor.collect_garbage` | write | `full_purge` | — | 기본 | force a garbage collection<br>⚠️ a GC pass stalls the game thread; never during a PIE measurement |
| `editor.get_dirty` | read | — | — | 기본 | dirty packages, split into agent-touched and everything else |
| `editor.get_focus_context` | read | `focusedEditor` `name` `openEditors` | — | 기본 | which asset editors are open, which has focus, and what is selected in it |
| `editor.get_project_info` | read | — | — | 기본 | alias of project.info |
| `editor.quit` | **dangerous** | `force` | — | 기본 | close the editor<br>⚠️ the 200 is sent and then the process dies: unsaved work is lost. Never in an auto-retry path. |
| `editor.redo` | write | `steps` | — | 기본 | redo steps on the agent buffer |
| `editor.restart` | **dangerous** | `force` | — | 기본 | restart the editor<br>⚠️ the 200 is sent and then the process dies: unsaved work is lost and the socket drops. Never in an auto-retry path. |
| `editor.save` | **dangerous** | `assets` `scope` | — | 기본 | save packages to disk<br>⚠️ scope "touched" (default) saves only what agent commands dirtied; "all" also saves the user’s own edits |
| `editor.screenshot` | read | `resolution` `show_ui` `warmup_frames` `world` | — | 120초 차단 | capture the viewport (or the game world during PIE) to a PNG on disk<br>⚠️ the result is a file path, not an image; pending_shaders / pending_assets / streaming_in_flight nonzero means the picture is not the finished look — use ual_screenshot to get the image itself |
| `editor.undo` | write | `steps` | — | 기본 | undo steps on the AGENT’S OWN transaction buffer (the user’s Ctrl+Z history is untouched)<br>⚠️ steps<=0 undoes everything on that buffer; read affected_packages / affected_objects — a level switch can make the restore a no-op |
| `editor.undo_history` | read | `limit` | — | 기본 | the agent buffer’s remaining steps with the packages and objects each touched |

### `input` (4)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `input.add_mapping` | write | `action_path` `context_path` `key` `modifiers` `system` `triggers` `value_type` | `key` | 기본 | add a key mapping to an input action / mapping context |
| `input.inject_action` | write | `action` `frames` `player_index` `value` `x` `y` `z` | — | 기본 | inject an action event |
| `input.inject_key` | write | `event` `frames` `key` `player_index` | — | 기본 | inject a raw key event into the editor<br>⚠️ answers 409 while PIE is running and suggests pie.* instead |
| `input.map` | read | `player_index` | — | 기본 | the enabled input bindings, actions, and mapping contexts |

### `landscape` (3)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `landscape.create` | write | `height_range_m` `heightmap_path` `label` `material` `quad_size_m` `rvt` `size_x_m` `size_y_m` `wp_grid_size` | — | 기본 | create a landscape |
| `landscape.list` | read | — | — | 기본 | the landscapes in this level |
| `landscape.setup_rvt` | write | `landscape` | — | 180초 차단 | set up Runtime Virtual Texture for a landscape |

### `level` (8)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `level.get_current` | read | — | — | 기본 | the open level name and path |
| `level.list` | read | — | — | 기본 | the levels in this project |
| `level.new` | **dangerous** | `force` `save_as` | — | 기본 | create a new level, optionally saving it<br>⚠️ a map change clears the agent undo buffer in the plugin — a session rollback budget does not survive it |
| `level.open` | **dangerous** | `force` `path` | — | 240초 차단 | load a level<br>⚠️ the plugin clears both undo buffers before loading, so nothing done in this session is undoable afterwards |
| `level.organize_actors` | write | `class` `filter` `folder_path` | — | 기본 | move actors into outliner folders |
| `level.query_assets` | read | `class_filter` `conditions` `limit` `path` `scope` `sort_by` `type` | — | 기본 | asset usage inside the current level |
| `level.save` | **dangerous** | `path` | — | 기본 | save the current level to disk<br>⚠️ outlives the session; auto-rollback cannot undo a save |
| `level.set_streaming` | write | `always_loaded` `level` `should_be_loaded` `should_be_visible` `visible_in_editor` | — | 기본 | change a sublevel streaming setting |

### `locks` (1)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `locks.set` | write | `enforced` `level_locked` `paths` | — | 기본 | replace the whole asset-lock table the editor draws badges from<br>⚠️ the enforced subset has its files marked READ-ONLY on disk and engine Save All silently skips them — never send enforced unless the caller asked for it |

### `material` (20)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `material.add_node` | write | `collection_path` `function_path` `group_name` `material_path` `node_id` `node_name` `node_type` `path` `position` `positions` `properties` `source_node` `source_pin` `target_node` `target_pin` `texture_path` `x` `y` | — | 기본 | add an expression node |
| `material.apply` | write | `component_name` `material_path` `slot_index` `slot_name` `slots` `targets` | — | 기본 | apply a material to actor mesh slots |
| `material.compile` | write | `path` | — | 120초 차단 | compile a material |
| `material.connect_pins` | write | `material_path` `source_node` `source_pin` `target_node` `target_pin` | — | 기본 | wire expression pins |
| `material.create` | write | `blend_mode` `destination_path` `fail_if_exists` `material_name` `shading_model` `two_sided` | — | 기본 | create a material asset |
| `material.create_function` | write | `description` `destination_path` `function_name` | — | 기본 | create a material function |
| `material.create_instance` | write | `destination_path` `instance_name` `parent_path` | — | 기본 | create a material instance |
| `material.delete_node` | write | `material_path` `node_id` | — | 기본 | delete expression nodes |
| `material.delete_unused_nodes` | write | `dry_run` `material_path` | — | 기본 | prune unconnected nodes |
| `material.describe` | read | `path` | — | 기본 | a material’s parameters, blend mode, and node summary |
| `material.disconnect_pins` | write | `material_path` `target_node` `target_pin` | — | 기본 | cut expression wires |
| `material.duplicate` | write | `destination_path` `new_name` `source_path` | — | 기본 | duplicate a material |
| `material.get_graph` | read | `include_values` `path` | — | 기본 | a material expression graph |
| `material.get_referencers` | read | `asset_path` `limit` | — | 기본 | what references this material |
| `material.parameter_collection` | write | `action` `collection_name` `collection_path` `destination_path` `name` `scalars` `vectors` | — | 기본 | create or edit a parameter collection |
| `material.search_nodes` | read | `limit` `query` | — | 기본 | find material nodes |
| `material.set_node_positions` | write | `material_path` `node_id` `positions` `x` `y` | — | 기본 | move expression nodes |
| `material.set_node_value` | write | `material_path` `node_id` `properties` | — | 기본 | set an expression’s value |
| `material.set_param` | write | `error` `params` `path` `valid_values` | — | 기본 | set static-switch / vector / scalar parameters on an instance |
| `material.set_property` | write | `blend_mode` `error` `path` `properties` `shading_model` `two_sided` `valid_values` | — | 기본 | set a material property (blend mode, domain, flags) |

### `mesh` (1)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `mesh.describe` | read | `path` | — | 기본 | a mesh asset’s statistics |

### `messagelog` (2)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `messagelog.get` | read | `category` `limit` | `category` | 기본 | one Message Log entry |
| `messagelog.list` | read | — | — | 기본 | the editor Message Log (pull only — the push events were removed upstream) |

### `pcg` (18)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `pcg.add_node` | write | `graph_path` `node_type` `title` `x` `y` | — | 기본 | add a node |
| `pcg.apply_graph` | write | `edges` `from` `from_pin` `graph_path` `id` `mode` `nodes` `to` `to_pin` `type` `x` `y` | — | 기본 | apply a graph to a volume |
| `pcg.connect_pins` | write | — | — | 기본 | wire PCG nodes |
| `pcg.create_graph` | write | `name` `path` | — | 기본 | create a PCG graph asset |
| `pcg.describe_node` | read | `graph_path` `limit` `node_id` | — | 기본 | describe one graph node |
| `pcg.diagnose` | read | `graph_path` | — | 120초 차단 | diagnose why a graph produced nothing |
| `pcg.disconnect_pins` | write | — | — | 기본 | cut PCG wires |
| `pcg.execute` | write | `actor_label` `timeout_seconds` `verbose` | — | 900초 차단 | execute PCG generation for volumes<br>⚠️ minutes of blocked game thread on a large volume |
| `pcg.get_graph` | read | `graph_path` | — | 기본 | a PCG graph |
| `pcg.get_node_schema` | read | `node_type` | — | 기본 | one node type’s parameter schema |
| `pcg.graph_parameters` | write | `graph_path` `name` `parameters` `remove` `type` | — | 기본 | set graph-level parameters |
| `pcg.list_node_types` | read | `limit` `search` | — | 기본 | available PCG node types |
| `pcg.remove_node` | write | `graph_path` `node_id` | — | 기본 | remove a node |
| `pcg.scene_report` | read | — | — | 120초 차단 | every PCG component in the level and its state |
| `pcg.set_node_positions` | write | `graph_path` `node_id` `positions` `x` `y` | — | 기본 | move PCG nodes |
| `pcg.spawn_volume` | write | `graph_path` `label` | — | 기본 | spawn a PCG volume |
| `pcg.status` | read | — | — | 기본 | whether the PCG plugin is usable in this project |
| `pcg.update_node` | write | `comment` `graph_path` `node_id` `title` | — | 기본 | update a node |

### `pie` (10)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `pie.click_widget` | write | `id` | — | 기본 | click a UMG widget<br>⚠️ answers 409 while PIE is running: the hit test needs a tick the blocked game thread will not give |
| `pie.move_stop` | write | — | — | 기본 | stop the pawn |
| `pie.move_to` | write | `accept_radius` `auto_jump` `edge_drop` `final_radius` `jump_gaps` `max_seconds` `points` `stop_at_edge` `x` `y` `z` | — | 120초 차단 | drive the pawn to a location |
| `pie.nav_path` | read | `random_radius` | — | 기본 | walk a navigation path |
| `pie.observe` | read | `heading_yaw` `include_widgets` `log_since` `max_logs` `sensors` `targets` | — | 기본 | sense the live PIE world: pawn, targets, widgets, sensors, recent logs |
| `pie.plan_path` | read | `max_drop` | — | 기본 | plan a navigation path |
| `pie.run` | write | `at` `command` `duration_seconds` `events` `fixed_fps` `frame_mode` `frame_times` `frames` `screenshot` `stop_on_error` | — | 300초 차단 | run a timed PIE playtest and report what happened (errors, actor deltas, optional screenshots)<br>⚠️ blocks the game thread for duration_seconds plus up to 15 s of startup and teardown — run it through ual_task |
| `pie.scene` | read | `heading_yaw` `max_actors` | — | 기본 | the PIE scene summary |
| `pie.set_view` | write | `pitch` `yaw` | — | 기본 | set the PIE player camera, including cinematic override |
| `pie.stop` | write | `reason` | — | 기본 | end a running PIE session |

### `project` (6)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `project.analyze_uproject` | read | `Enabled` `EngineAssociation` `Modules` `Name` `Plugins` `TargetPlatforms` `enabled` `name` | — | 기본 | validate a .uproject: missing plugins, bad EngineAssociation |
| `project.apply_asset_guidelines` | **dangerous** | — | — | 기본 | write the project asset guidelines, which every other tool then inherits |
| `project.check_asset_guidelines` | read | — | — | 기본 | the project asset-guideline verdict |
| `project.get_config` | read | `config_name` `key` `section` | `config_name` `key` `section` | 기본 | read one value from a project .ini |
| `project.info` | read | — | — | 기본 | the same payload as the project.info event, on demand |
| `project.set_config` | **dangerous** | `config_name` `key` `section` `value` | `config_name` `key` `section` `value` | 기본 | write one value into a project .ini (outlives the session, survives undo) |

### `sequence` (9)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `sequence.audit` | read | `paths` `recursive` | `paths` | 120초 차단 | audit a sequence for binding and track problems |
| `sequence.camera_cuts` | read | `camera_label` `rebuild` `sequence_path` | `sequence_path` | 기본 | the camera-cut list for a sequence |
| `sequence.camera_keys` | read | `camera_cuts` `camera_label` `focal_length_mm` `fps` `frame` `interpolation` `keys` `location` `playback_end_frame` `rebuild_camera_cuts` `replace_existing_keys` `rotation` `sequence_path` | `camera_label` `sequence_path` | 기본 | a camera cut’s keyframes |
| `sequence.describe` | read | `bindings` `detail` `max_bindings` `max_keys` `sequence_path` | `sequence_path` | 기본 | a Level Sequence’s tracks and bindings |
| `sequence.diff` | read | `base_path` `binding_map` `bindings` `compare_path` | — | 기본 | compare two Level Sequences semantically: tracks, bindings, camera coverage |
| `sequence.rebind` | write | `actor` `allow_class_change` `binding` `sequence_path` | `actor` `binding` `sequence_path` | 기본 | rebind sequence tracks to different actors |
| `sequence.render` | write | `format` `frame_end` `frame_start` `map_path` `output_dir` `preset_path` `quality` `renderer` `resolution` `sequence_path` | `sequence_path` | 1800초 차단 | render a sequence with Movie Render Queue<br>⚠️ blocks the game thread for the whole render and replies only at the end; the returned job_id is a key for sequence.render_status, which cannot be served until the render finishes. Use ual_task. |
| `sequence.render_cancel` | write | `job_id` | — | 기본 | cancel a render job |
| `sequence.render_status` | read | `job_id` | — | 기본 | the progress of a render job |

### `system` (7)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `system.capture_insights_trace` | write | `channels` `duration_seconds` | — | 120초 차단 | capture an Insights trace |
| `system.capture_perf_trace` | write | `duration_seconds` `gpu_stats` | — | 120초 차단 | capture a CSV or Unreal Insights perf trace<br>⚠️ CSV profiling is exclusive — a second request while one runs gets 409 |
| `system.get_editor_health` | read | — | — | 기본 | startup cost, asset-registry state, hitch %, DDC hit rate, free memory (null means unavailable, not zero) |
| `system.get_performance_stats` | read | — | — | 기본 | fps / frame / game / render / rhi / gpu ms<br>⚠️ render_thread_ms reads 0 on some machines regardless of activity — it is not evidence the editor is idle |
| `system.get_project_info` | read | `fingerprint` | — | 기본 | engine and project facts, plus the capability flags that say what this plugin build supports |
| `system.manage_plugin` | **dangerous** | `action` `plugin_name` | `plugin_name` | 기본 | enable or disable a project plugin (rewrites the .uproject) |
| `system.run_console_command` | **dangerous** | `command` | `command` | 기본 | execute an arbitrary engine console command<br>⚠️ unbounded side effects; output is truncated to 8000 chars and reports output_truncated_chars |

### `viewport` (1)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `viewport.focus` | write | `all_viewports` `direction` `distance` `region` | — | 60초 차단 | frame the viewport on actors, a region, or a direction |

### `widget` (8)

| 명령 | 위험 | 파라미터 | 필수 | 타임아웃 | 설명 |
|---|---|---|---|---:|---|
| `widget.add_child` | write | `anchors` `bottom` `control_type` `h_align` `height` `left` `name` `padding` `parent_name` `path` `position` `right` `size` `size_rule` `text` `top` `v_align` `width` `x` `y` | — | 기본 | add a child widget |
| `widget.create` | write | `folder` `name` `root_type` | — | 기본 | create a widget blueprint |
| `widget.get_hierarchy` | read | `path` | — | 기본 | a widget tree with slot info |
| `widget.make_variable` | write | `path` `variable_name` `widget_name` | — | 기본 | expose a widget as a blueprint variable |
| `widget.preview` | read | `height` `path` `width` | — | 기본 | render a widget preview<br>⚠️ returns a file path, not an image |
| `widget.set_canvas_slot` | write | `alignment` `anchors` `path` `position` `size` `widget_name` `z_order` | — | 기본 | position a canvas slot |
| `widget.set_property` | write | `a` `b` `g` `path` `property_name` `r` `value` `widget_name` | — | 기본 | set a widget property |
| `widget.set_vertical_slot` | write | `bottom` `h_align` `left` `padding` `path` `right` `size_rule` `top` `v_align` `widget_name` | — | 기본 | set a vertical-box slot |

## 결과 키

각 명령의 `result`에 나타나는 키입니다. `ual_schema`와 모델이 참고합니다.

| 명령 | 결과 키 | 상태 코드 |
|---|---|---|
| `system.get_project_info` | `blueprint_require_empty` `capabilities` `content_dir` `engine_dir` `engine_major` `engine_minor` `engine_source_dir` `engine_version` `has_code` `intermediate_dir` `material_fail_if_exists` `ok` `plugin_build` `plugin_version` `plugins_dir` `project_dir` `project_name` `project_path` `project_source_dir` `python` `saved_dir` | 200 |
| `system.get_editor_health` | — | 200 |
| `system.get_performance_stats` | `fps` `frame_ms` `game_thread_ms` `gpu_ms` `render_thread_ms` `rhi_thread_ms` | 200 |
| `system.run_console_command` | `error` `output` `output_note` `output_truncated_chars` `result` | 400 |
| `system.manage_plugin` | `default_enabled` `friendly_name` `is_enabled` `message` `plugin_name` `requires_restart` `uproject_path` `uproject_state` `uproject_verified` | 400 / 404 |
| `system.capture_perf_trace` | `actual_elapsed_seconds` `avg_fps` `bottleneck` `csv_path` `frame_count` `gpu_stats_enabled` `idle_sample` `note` `ok` `p99_fps` `requested_duration_seconds` `stats` `worst_frame` | 200 / 409 / 500 |
| `system.capture_insights_trace` | `actual_elapsed_seconds` `channels` `note` `ok` `requested_duration_seconds` `utrace_path` | 200 / 409 / 500 |
| `project.info` | — | 200 |
| `editor.get_project_info` | — | 200 |
| `project.get_config` | `config_name` `file_path` `key` `section` `value` | 200 / 400 |
| `project.set_config` | `applied_live` `auto_answered_dialogs` `config_name` `file_path` `key` `persisted` `read_back` `requested_value` `section` `value` `via` | 200 / 400 / 500 |
| `project.analyze_uproject` | `base_dir` `category` `description` `enabled` `engine_association` `friendly_name` `modules` `name` `plugins` `target_platforms` `version_name` | 200 / 500 |
| `project.check_asset_guidelines` | `bad_paths` `candidate_packages` `guidelines` `load_failed` `pending_restart` `popups_suppressed_while_loading` `scanned_packages` `truncated` `unmet_plugins` `unmet_settings` `unreadable_packages` | 200 |
| `project.apply_asset_guidelines` | `error` `failed_count` `file` `friendly_name` `guideline` `guidelines_matched` `key` `name` `on_disk` `plugins_to_enable` `required` `restart_required` `result` `results` `section` `status` `written_count` | 200 |
| `actor.spawn` | `asset_id` `class` `count` `created` `cvar` `error` `failed` `failed_count` `field` `index` `instances` `max` `name` `path` `preset` `reason` `renamed` `requested` `requested_name` `type` | 200 / 413 / 500 |
| `actor.get` | `actors` `count` `names` `paths` | 200 / 400 / 404 / 500 |
| `actor.get_info` | `actors` `count` `total_found` | 200 / 400 / 404 / 500 |
| `actor.inspect` | `actors` `count` `props` | 200 / 400 / 404 / 500 |
| `actor.inspect_components` | — | 200 / 400 |
| `actor.set_property` | `ActorLabel` `FolderPath` `Mobility` `SimulatePhysics` `Tags` `actors` `actual` `bHidden` `bHiddenInEditor` `count` `current_value` `error` `errors` `expected_type` `failed_count` `ok` `property` `readback_unavailable` `requested` `suggestions` `updated` `warning` | 200 / 400 / 404 / 500 |
| `actor.set_transform` | `actors` `applied` `count` `error` `failed` `failed_count` `location` `name` `ok` `path` `reason` `report_limit` `reported` `requested` `rotation` `scale` `snap` `snap_missed` `warning` | 200 / 400 / 404 / 500 |
| `actor.destroy` | `class` `count` `deleted_actors` `error` `failed` `failed_count` `name` `ok` `path` `reason` `target_count` | 200 / 404 / 500 |
| `level.get_current` | `actor_count` `is_dirty` `is_temporary` `name` `ok` `package` | 200 / 404 |
| `level.list` | `ok` | 200 / 404 |
| `level.new` | `actor_count` `is_dirty` `is_temporary` `name` `note` `ok` `package` `save_error` `saved` `saved_as` `saved_file` | 200 / 400 / 409 / 500 |
| `level.open` | `actor_count` `is_dirty` `is_temporary` `name` `ok` `package` | 200 / 400 / 404 / 409 / 500 |
| `level.save` | `actor_count` `is_dirty` `is_temporary` `name` `note` `ok` `package` `saved_as` `saved_file` `saved_level_is_persistent` | 200 / 400 / 404 / 500 |
| `level.set_streaming` | `actor_count` `after` `always_loaded` `ambiguous` `available_levels` `before` `changed` `is_loaded` `is_visible` `level` `mismatch` `mismatch_reason` `name` `needs_save` `ok` `package` `should_be_loaded` `should_be_visible` `streaming_class` `undoable` `visible_at_runtime` `visible_in_editor` | 200 / 400 / 404 / 409 / 500 |
| `level.organize_actors` | `actors` `class_contains` `count` `error` `filter` `folder_path` `total_found` | 200 / 400 / 404 / 500 |
| `level.query_assets` | `actor_count` `actors_visited` `assets` `count` `instance_count` `lod_count` `matched_assets` `material_slots` `max_texture_edge` `max_texture_pixels` `missing_collision` `name` `nanite` `not_ranked_by_class` `path` `resource_bytes` `sample_actors` `shadow_casting` `stats` `texture_bytes` `total_triangles` `triangles` `truncated` `type` | 200 / 400 / 500 |
| `editor.get_dirty` | `is_level` `note` `ok` `other` `other_count` `package` `touched` `touched_count` | 200 |
| `editor.save` | `asset` `deleted` `error` `failed` `failed_count` `file` `is_level` `not_loaded` `not_loaded_count` `note` `ok` `package` `reason` `saved` `saved_count` `scope` `skipped` `skipped_count` `still_dirty_count` | 200 / 400 / 404 |
| `editor.screenshot` | `camera_location` `camera_rotation` `camera_source` `exposure` `exposure_source` `filename` `height` `method` `path` `pending_assets` `pending_shaders` `pitch` `restore_app_window` `roll` `saved` `streaming_in_flight` `view` `wait_ms` `warmup_frames` `width` `world` `x` `y` `yaw` `z` | 200 / 500 / 501 |
| `editor.capture_app_window` | `filename` `height` `path` `saved` `width` `window_source` `window_title` | 200 |
| `editor.get_focus_context` | — | 200 / 501 |
| `editor.collect_garbage` | `elapsed_ms` `full_purge` `mb_after` `mb_before` `mb_freed` `objects_after` `objects_before` `objects_freed` `ok` | 200 |
| `editor.restart` | `note` `ok` `restarting` | 200 / 409 |
| `editor.quit` | `closing` `ok` | 200 / 409 |
| `editor.undo` | `action` `affected_objects` `affected_packages` `error` `ok` `redoable` `remaining` `step_titles` `steps_applied` | 200 |
| `editor.redo` | `action` `affected_objects` `affected_packages` `error` `ok` `redoable` `remaining` `step_titles` `steps_applied` | 200 |
| `editor.undo_history` | `context` `entries` `note` `object_count` `objects` `ok` `packages` `redoable` `returned` `step` `title` `undoable` | 200 |
| `viewport.focus` | `aim` `all_viewports` `bounds` `camera` `center` `distance` `error_degrees` `extent` `focused` `height` `hidden_in_editor` `hidden_levels` `is_active_viewport` `is_perspective` `max` `min` `moved` `occluded_by` `occluded_by_self` `on_target` `point` `radius` `region` `skipped_hidden_levels` `target_center` `target_radius` `transition_settled` | 200 / 400 / 404 / 409 / 500 / 501 |
| `pie.run` | `accepted` `actors_at_end` `actors_at_start` `actors_spawned` `at` `capture_ms` `command` `elapsed_seconds` `ended_by` `error` `error_count` `errors` `events` `fired` `fixed_fps` `frame_mode` `frames` `levels` `ok` `path` `print_strings` `ran` `requested_seconds` `screenshot_error` `screenshot_path` `stop_reason` `warning_count` `warnings` | 200 / 400 / 409 / 500 |
| `pie.stop` | `ok` `stopping` | 200 / 409 |
| `pie.observe` | `at` `buttons` `buttons_truncated` `cinematic_mode` `class` `control_rotation` `distance` `enabled` `found` `frame` `game_time` `has_controller` `id` `input` `kill_z` `kind` `label` `location` `log_cursor` `logs` `logs_dropped` `look_input_ignored` `match_count` `move` `move_input_ignored` `name` `ok` `owner` `paused` `pawn` `playing` `query` `sensors` `seq` `session_active` `session_elapsed` `show_mouse_cursor` `targets` `text` `viewport_ignores_input` | 200 |
| `pie.plan_path` | `cell` `expanded` `found` `goal_floor` `goal_walkable` `grid` `jumps` `length` `link` `ms` `ok` `partial` `points` `raw` `reason` `start_floor` `walkable` `x` `y` `z` | 200 / 400 |
| `pie.nav_path` | `found` `has_navmesh` `is_partial` `length` `ok` `point` `points` | 200 / 400 |
| `pie.scene` | `actors` `controller_vars` `has_navmesh` `heading_yaw` `level` `location` `ok` `pawn_vars` `player` `state_vars` `total_relevant` `truncated` | 200 |
| `pie.move_to` | `ok` `skipped_points` `valid_points` | 200 / 400 / 409 |
| `pie.move_stop` | `ok` | 200 |
| `pie.set_view` | `control_rotation` `ok` | 200 / 400 / 409 |
| `pie.click_widget` | `id` `layer_note` `ok` `text` | 200 / 400 / 404 / 409 |
| `content.search` | `class` `count` `folder_count` `folder_counts` `folders` `name` `note` `ok` `path` `results` `searched_path` `total` `truncated` | 200 |
| `content.describe` | `bounds` `class` `compression` `dependencies` `dependencies_count` `details` `height` `lod_count` `material_slots` `max` `migration_hint` `min` `name` `nanite_enabled` `ok` `package` `package_size_bytes` `path` `pixel_format` `referencers` `referencers_count` `size` `srgb` `triangles_lod0` `vertices_lod0` `width` | 200 / 400 / 404 |
| `content.dependencies` | `by_class` `class` `count` `dependencies` `depth` `direction` `disk_size` `edges` `edges_truncated` `external` `from` `hard_only` `max_depth_reached` `missing` `nodes` `nodes_truncated` `notes` `ok` `path` `referencers` `root` `root_asset_count` `root_count` `scope_is_folder` `to` `total_disk_size` `truncated` `unreferenced` `unreferenced_count` `unreferenced_disk_size` `unreferenced_truncated` | 200 / 400 / 404 |
| `content.asset_ranking` | `assets` `by_class` `class` `count` `disk_size` `format` `height` `lod_count` `name` `nanite` `notes` `ok` `path` `returned` `scanned` `scope_path` `stats` `texture_bytes` `total_disk_size` `triangles` `truncated` `vertices` `width` | 200 |
| `content.size_map` | `class` `dependency_count` `note` `ok` `path` `root` `size` `top_contributors` `total_size` `truncated` | 200 / 400 / 404 |
| `content.naming_audit` | `ambiguous` `ambiguous_count` `by_class` `by_reason` `class` `compliant` `compliant_count` `conflict` `conflict_count` `conflict_keep` `expected_prefix` `name` `note` `ok` `path` `reason` `rule_source` `rules_source` `rules_used` `scanned` `skipped_count` `suggested_name` `suggested_name_keep` `suggested_path` `suggested_path_keep` `truncated` `unknown_classes` `violation_count` `violations` | 200 |
| `content.audit_optimization` | `enabled_in_config` `estimated_memory_bytes` `estimated_memory_mb` `height` `large_textures` `large_textures_4k` `large_textures_omitted` `lumen_usage` `materials_with_emissive` `mesh_count` `meshes_with_nanite` `name` `nanite_usage` `path` `suggestion` `texture_analysis` `total_textures` `using_lumen_gi` `width` | 200 |
| `content.registry_status` | — | 200 |
| `content.registry_scan` | `assets` `path` `registered` `scanned_files` `scanned_paths` `total_assets` | 200 / 400 |
| `content.import` | `auto_generated` `auto_generated_count` `class` `error` `failed` `failed_count` `file` `imported` `imported_count` `name` `ok` `path` `reason` `rejected` `rejected_count` `requested_count` `save_warning` `saved_count` `source_file` `succeeded_count` | 200 / 400 |
| `content.normalized_import` | `class` `errors` `failed_count` `from` `imported` `new_path` `normalized_name` `ok` `old_path` `original_name` `redirects` `success_count` `to` `total_files` `warnings` | 400 |
| `content.delete` | `deleted` `deleted_count` `dropped_agent_undo_steps` `engine_deleted_objects` `error` `failed` `failed_count` `ok` `path` `reason` `requested_count` | 200 / 400 |
| `content.move` | `destination_path` `error` `message` `ok` `original_destination` `renamed` `saved` `source_path` | 400 / 404 / 409 / 500 |
| `content.batch_move` | `auto_answered_dialogs` `auto_renamed` `bytes` `cdo_refs` `checkout` `class` `conflicts` `destination` `dirty_after` `dry_run` `elapsed_ms` `engine_log` `error` `errors` `failed` `file` `items` `items_truncated` `moved` `mtime` `notes` `ok` `on_conflict` `planned` `reason` `redirectors_fixed` `redirectors_found` `redirectors_left` `referencers` `save_failed` `saved_count` `skipped` `source` `status` | 200 / 400 / 409 |
| `content.fixup_redirectors` | `broken` `broken_count` `broken_left` `checkout` `deleted_broken` `details` `dirty_after` `dry_run` `engine_log` `error` `fixed` `found` `how_to` `listed_note` `note` `ok` `path` `redirectors` `remaining` `target` | 200 / 400 / 409 |
| `content.migrate` | `bytes` `copied` `destination_content_dir` `destination_file` `dry_run` `elapsed_ms` `error` `external_skipped` `failed` `files` `files_truncated` `is_root` `missing` `not_found` `notes` `ok` `package` `planned` `root_count` `save_failed` `skipped` `status` `total_bytes` `unsaved_sources` | 200 / 400 / 404 |
| `blueprint.create` | `existing_class` `message` `name` `ok` `path` `save_warning` `saved` `warnings` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.describe` | — | 200 / 400 / 404 |
| `blueprint.compile` | `diagnostics` `message` `node_id` `ok` `path` `pin` `saved` `severity` `status` `type` | 200 / 400 / 404 |
| `blueprint.compile_all` | `compiled_count` `error_count` `errors` `failures` `message` `messages` `note` `ok` `path` `scope` `severity` `truncated` `truncated_note` `warning_count` `warnings` | 200 / 400 |
| `blueprint.add_variable` | `blueprint_path` `container` `default_value` `is_array` `name` `ok` `sub_category_object` `type` `variable` | 200 / 400 / 404 / 409 |
| `blueprint.remove_variable` | `blueprint_path` `name` `note` `ok` `removed` | 200 / 400 / 404 |
| `blueprint.set_variable_meta` | `applied` `blueprint_path` `blueprint_read_only` `category` `compile_error_count` `compiled` `expose_on_spawn` `instance_editable` `name` `ok` `replication` `tooltip` `type` `variable` `warning` | 200 / 400 / 404 |
| `blueprint.add_component` | `all_components` `attach_warning` `attached` `attached_to` `blueprint_name` `blueprint_path` `component_class` `component_name` `failed_properties` `message` `ok` `saved` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.set_parent_class` | `blueprint_path` `compile_errors` `compile_warnings` `messages` `new_parent` `note` `ok` `old_parent` | 200 / 400 / 404 |
| `blueprint.set_property` | `blueprint_name` `blueprint_path` `compile_status` `compiled` `component_name` `error` `failed_properties` `message` `modified_properties` `ok` `property` `saved` `suggestions` `target_type` `type` `undoable` `value` | 400 / 404 / 500 |
| `blueprint.create_graph` | `blueprint_path` `category` `class` `compile_error_count` `compile_warning_count` `compiled` `connection_count` `count` `created_count` `cvar` `default_object` `default_text` `default_value` `diagnostics` `dir` `errors` `field` `friendly_name` `graph` `graph_name` `id` `is_array` `is_connected` `is_const` `is_reference` `linked_count` `linked_to` `max` `message` `name` `node` `node_class` `node_id` `node_title` `nodes` `ok` `pin_name` `pins` `reason` `removed_count` `reused` `rolled_back` `severity` `sub_category` `sub_category_object` `undoable` `warnings` | 200 / 400 / 404 / 409 |
| `blueprint.create_function` | `entry_node_id` `graph_name` `ok` `result_node_id` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.create_event_graph` | `blueprint_path` `event_graphs` `graph_name` `ok` `saved` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.function_signature` | `action` `blueprint_path` `graph_name` `inputs` `name` `note` `ok` `outputs` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.list_graphs` | `blueprint_path` `delegate_graphs` `event_graphs` `function_graphs` `graph_count` `graph_names` `graphs` `intermediate_graphs` `macro_graphs` `ok` `preferred_graph` | 200 / 400 / 404 |
| `blueprint.get_graph` | `blueprint_path` `class` `comment_text` `font_size` `graph_kind` `graph_name` `is_ghost_node` `next_offset` `node_height` `node_id` `node_width` `nodes` `nodes_under_comment` `offset` `ok` `pins` `pos_x` `pos_y` `title` `total_node_count` | 200 / 400 / 404 |
| `blueprint.search_nodes` | `anim_nodes` `anim_note` `class` `cpp_name` `dir` `functions` `is_pure` `match_count` `member_name` `name` `note` `ok` `params` `query` `summary` `total_candidates` `type` | 200 / 400 |
| `blueprint.delete_node` | `blueprint_path` `graph_name` `message` `node_id` `ok` | 200 / 400 / 404 |
| `blueprint.disconnect_pins` | `blueprint_path` `broken` `graph_name` `ok` `remaining` | 200 / 400 / 404 |
| `blueprint.set_node_positions` | `blueprint_path` `graph_name` `moved` `not_found` `note` `ok` | 200 / 400 / 404 |
| `blueprint.set_comment` | `blueprint_path` `created` `enclosed_nodes` `graph_name` `height` `node_id` `not_found` `note` `ok` `text` `width` `x` `y` | 200 / 400 / 404 |
| `blueprint.event_dispatcher` | `blueprint_path` `class` `container` `created` `dispatchers` `name` `note` `object_class` `ok` `params` `type` | 200 / 400 / 404 / 409 / 500 |
| `blueprint.component_event` | `blueprint_path` `category` `component_class` `component_name` `default_object` `default_text` `default_value` `dir` `event_name` `events` `friendly_name` `graph_name` `is_array` `is_connected` `is_const` `is_reference` `linked_count` `linked_to` `name` `node_class` `node_id` `node_title` `note` `ok` `params` `pin_name` `pins` `reused` `sub_category` `sub_category_object` `type` | 200 / 400 / 404 / 500 |
| `blueprint.export_t3d` | `blueprint_path` `exported_node_ids` `graph_name` `node_count` `not_found` `note` `ok` `text` `text_length` `truncated` | 200 / 400 / 404 |
| `blueprint.import_t3d` | `blueprint_path` `class` `compile_error_count` `compile_warning_count` `compiled` `diagnostics` `graph_name` `id` `imported_count` `is_ghost_node` `message` `node_id` `nodes` `ok` `reason` `removed_ghost_events` `removed_ghost_events_note` `self_context_note` `self_context_unresolved` `severity` `structural` `text_length` `title` `undoable` `x` `y` | 200 / 400 / 404 / 409 / 422 |
| `material.create` | `available_pins` `blend_mode` `material_name` `material_package_path` `material_path` `material_type` `object_in_memory` `package_on_disk` `substrate_enabled` `two_sided` | 200 / 400 / 409 / 500 |
| `material.create_instance` | `available_params` `error` `instance_name` `instance_path` `parent_had_open_editor` `parent_note` `parent_path` `scalar_params` `similar_materials` `success` `suggestions` `texture_params` `vector_params` | 200 / 400 / 404 / 500 |
| `material.create_function` | `function_name` `function_path` `note` | 200 / 400 / 500 |
| `material.describe` | `a` `b` `blend_mode` `class` `editor_note` `g` `has_open_material_editor` `name` `node_count` `parent_material` `path` `r` `scalar_params` `shading_model` `texture_params` `two_sided` `value` `vector_params` | 200 / 400 / 404 |
| `material.get_graph` | `class` `connection_count` `connections` `description` `display_name` `from_node` `from_output` `from_pin` `from_type` `guid` `ignored_by_substrate` `index` `inputs` `is_connected` `material_name` `material_node_position` `material_path` `material_pins` `name` `node_count` `node_id` `nodes` `note` `outputs` `position` `properties` `reroute_declaration_node` `reroute_error` `reroute_kind` `reroute_name` `substrate_enabled` `to_input` `to_node` `to_type` `type` `use_material_attributes` `x` `y` | 200 / 400 / 404 |
| `material.search_nodes` | `class` `has_value` `index` `inputs` `match_count` `name` `node_type` `nodes` `note` `ok` `outputs` `properties` `query` `requires` `substrate_enabled` `substrate_note` `total_types` `truncated` `type` | 200 |
| `material.get_referencers` | `asset_path` `class` `incomplete_reason` `path` `referencer_count` `referencers` `truncated` `unsaved_package_count` | 200 / 400 |
| `material.add_node` | `class` `collection_applied` `collection_error` `compiled` `connection` `disconnected_count` `display_name` `error` `error_nodes` `errors` `from` `from_output` `guid` `has_errors` `initial_value_applied` `initial_value_error` `material_name` `material_path` `moved` `name` `node_class` `node_id` `not_found` `note` `pins` `position` `properties` `resolved_texture_path` `suggestions` `texture_applied` `texture_path` `to` `type` `warnings` `x` `y` | 200 / 400 / 404 / 500 |
| `material.delete_node` | `disconnected_count` `node_id` | 200 / 400 / 404 |
| `material.delete_unused_nodes` | `class` `deleted_count` `dry_run` `guid` `node_id` `note` `unused` `unused_count` | 200 / 400 / 404 |
| `material.connect_pins` | `connection` `from` `from_output` `to` | 200 / 400 / 404 / 500 |
| `material.disconnect_pins` | `disconnected` `note` `target_node` `target_pin` `was_connected_to` | 200 / 400 / 404 |
| `material.set_node_value` | `node_class` `node_id` `properties` | 200 / 400 / 404 |
| `material.set_node_positions` | `material_path` `moved` `not_found` | 200 / 400 / 404 |
| `material.set_property` | `blend_mode` `current_state` `error` `failed_properties` `material_path` `name` `two_sided` `updated_properties` `valid_values` | 400 / 404 |
| `material.set_param` | `error` `errors` `material_path` `param` `updated_params` | 400 |
| `material.compile` | `class` `compiled` `error` `error_nodes` `errors` `has_errors` `material_name` `material_path` `node_id` `note` `warnings` | 200 / 400 / 404 |
| `material.apply` | `actors` `applied_count` `component` `error` `material` `material_path` `mesh_component_count` `name` `other_components` `path` `previous` `reason` `skipped` `skipped_count` `skipped_summary` `slot_index` `slot_name` `slot_request_count` `slots` `target_count` | 400 / 404 / 500 |
| `material.duplicate` | `error` `new_name` `new_path` `similar_assets` `source_had_open_editor` `source_note` `source_path` `success` `suggestions` | 200 / 400 / 404 / 500 |
| `material.parameter_collection` | `a` `b` `collection_name` `collection_path` `created` `g` `name` `note` `r` `rejected` `scalar_slots_left` `scalars` `value` `vector_slots_left` `vectors` | 200 / 400 / 404 / 500 |
| `widget.create` | `name` `ok` `path` `requested_root_type` `root_type` `saved` `warning` | 200 / 400 / 409 / 500 / 501 |
| `widget.get_hierarchy` | `name` `path` `root` `widget_count` | 200 / 400 / 404 / 500 / 501 |
| `widget.add_child` | `class` `failed_count` `ignored_fields` `ignored_note` `name` `ok` `parent` `parent_type` `replaced_child` `slot_data` `slot_type` `text` | 200 / 400 / 404 / 500 / 501 |
| `widget.set_property` | `message` `ok` `property_name` `widget_name` | 200 / 400 / 404 / 501 |
| `widget.set_canvas_slot` | `ok` `slot_data` `widget_name` | 200 / 400 / 404 / 501 |
| `widget.set_vertical_slot` | `ok` `slot_data` `widget_name` | 200 / 400 / 404 / 501 |
| `widget.make_variable` | `is_variable` `ok` `widget_name` | 200 / 400 / 404 / 501 |
| `widget.preview` | `height` `ok` `path` `width` | 200 / 400 / 404 / 500 / 501 |
| `sequence.describe` | `binding_total` `bindings` `bound_to` `broken_bindings` `camera_cuts` `capabilities` `channels` `display_rate` `duration_frames` `id` `name` `parent` `path` `playback_end` `playback_start` `resolution_checked` `sections` `sequence` `track_count` `tracks` `truncated` `type` `unresolved_bindings` | 200 / 400 / 404 |
| `sequence.diff` | — | 200 |
| `sequence.audit` | `binding_resolution` `capabilities` `engine_version` `error` `findings` `path` `reports` | 200 / 400 |
| `sequence.rebind` | `actor_candidates` `actor_class` `actor_label` `actor_path` `binding_candidates` `binding_guid` `binding_name` `broken_components` `class` `guid` `kind` `label` `name` `path` `previous_actor` `previous_name` `resolved` `sequence_path` `sequence_saved` `warnings` `was_broken` | 200 / 400 / 404 / 409 / 500 |
| `sequence.camera_keys` | `camera_created` `camera_cut_bound` `camera_label` `index` `kept_existing_cuts` `key_count` `level_saved` `range` `reason` `removed_cut_sections` `replaced_keys` `sequence_created` `sequence_path` `sequence_saved` `skipped_key_reasons` `skipped_keys` `warnings` `written_keys` | 200 / 400 / 409 / 500 |
| `sequence.camera_cuts` | `already_covered` `binding_broken` `camera_binding` `camera_cuts` `candidates` `range` `removed_sections` `sequence_path` `sequence_saved` `warnings` | 200 / 400 / 404 / 409 / 500 |
| `sequence.render` | `format` `frame_range` `job_id` `map_path` `output_dir` `preset_path` `quality` `renderer` `resolution` `sequence_path` `warnings` | 200 / 400 / 404 / 409 / 412 / 500 |
| `sequence.render_status` | `elapsed_seconds` `error` `job_id` `output_dir` `output_frame` `progress` `state` `total_frames` | 200 |
| `sequence.render_cancel` | `canceled` `state` | 200 |
| `pcg.status` | `available` `engine_version` `node_type_count` `plugin_beta` `plugin_enabled` `plugin_version` `reason` | 200 |
| `pcg.create_graph` | `graph_path` `input_node_id` `name` `output_node_id` | 200 / 400 / 409 / 500 |
| `pcg.get_graph` | `edge_count` `edges` `graph_path` `input_node_id` `node_count` `nodes` `output_node_id` | 200 / 400 / 404 |
| `pcg.list_node_types` | `display_name` `shown` `total_matched` `truncated_hint` `type` `types` | 200 |
| `pcg.get_node_schema` | `display_name` `input_pins` `name` `output_pins` `properties` `type` | 200 / 400 / 404 |
| `pcg.describe_node` | `graph_path` `properties` `property_count` `truncated_hint` | 200 / 400 / 404 / 500 |
| `pcg.add_node` | `failed_count` `failed_properties` `graph_path` `node_id` `updated_properties` | 200 / 400 / 404 / 500 |
| `pcg.update_node` | `error` `failed_count` `failed_properties` `graph_path` `name` `updated_properties` | 200 / 400 / 404 / 500 |
| `pcg.remove_node` | `graph_path` `node_count_after` `removed_node_id` | 200 / 400 / 404 / 500 |
| `pcg.connect_pins` | `from_node` `from_node_output_pins` `from_pin` `graph_path` `to_node` `to_node_input_pins` `to_pin` `verified` | 200 / 400 / 404 |
| `pcg.disconnect_pins` | `from_pin` `graph_path` `removed` `to_pin` | 200 / 400 / 404 / 500 |
| `pcg.set_node_positions` | `error` `failed` `failed_count` `graph_path` `item` `moved` `not_found` `skipped` `skipped_count` | 200 / 400 / 404 |
| `pcg.graph_parameters` | `added` `error` `failed` `failed_count` `graph_path` `name` `parameter_count` `parameters` `removed` `type` `updated` | 400 / 404 / 501 |
| `pcg.spawn_volume` | `actor_label` `actor_path` `actual_bounds` `center` `extent` `graph_assigned` `graph_assigned_unverified` `graph_path` `location` `max` `min` `size` | 200 / 404 / 500 / 501 |
| `pcg.apply_graph` | `alias` `applied_properties` `cleared_nodes` `created` `created_graph` `edges` `error` `failed_count` `failures` `from` `from_pin` `graph_edges_after` `graph_nodes_after` `graph_path` `item` `mode` `nodes` `still_present` `to` `to_pin` | 200 / 400 / 404 / 500 |
| `pcg.execute` | `actor_label` `component_count` `components` `elapsed_seconds` `engine_log` `generated` `instance_count` `note` `partitioned` `partitioned_instance_count` | 200 / 400 / 404 / 410 / 500 / 504 |
| `pcg.diagnose` | `fix` `graph_path` `node_count` `problem` `problems` `severity` `summary` `world_partition` | 200 / 400 / 404 |
| `pcg.scene_report` | `actor_label` `center` `extent` `graph` `landscape` `level_name` `level_package` `main_landscapes` `names` `notes` `partitioned` `pcg_volumes` `streaming_proxies_loaded` `unsaved_temp_level` `world_partition` | 200 / 500 |
| `landscape.create` | `candidate_resolutions` `engine_message` `failed_count` `height_range_m` `heightmap` `landscape` `material` `path` `quad_size_m` `requested` `resampled` `resolution` `rvt_results` `size_x_m` `size_y_m` `source_resolution` `undoable` `wp_grid_size` | 200 / 400 / 404 / 409 / 500 |
| `landscape.list` | `landscapes` | 200 / 500 |
| `landscape.setup_rvt` | `failed_count` `landscape` `rvt_results` | 200 / 400 / 404 / 500 |
| `mesh.describe` | `name` `path` | 200 / 400 / 404 |
| `datatable.describe` | `asset_path` `columns` `composite` `enum_values` `name` `ok` `path` `row_count` `row_names` `row_names_truncated` `row_struct` `rows` `source_file` `source_file_exists` `type` `unknown_columns` `unknown_rows` `user_defined` | 200 / 400 / 404 |
| `datatable.edit` | `applied` `asset_path` `failed_op_index` `from` `ok` `package` `removed` `renamed` `row_count` `rows` `source_file` `source_file_exists` `table_unchanged` `to` | 200 / 400 / 404 |
| `input.map` | `action_count` `actions` `contexts` `contexts_limit` `contexts_read_from` `contexts_truncated` `input_system` `ok` `runtime_error` `source` `source_note` | 200 |
| `input.add_mapping` | `action_created` `action_path` `already_mapped` `context_path` `contexts` `key` `keys` `ok` `saved` `system` `value_type` | 200 / 400 / 404 / 409 / 500 |
| `input.inject_key` | `accepted` `event` `frames` `held_note` `injected_at` `interrupted` `key` `layer_note` `ok` | 200 / 400 / 409 |
| `input.inject_action` | `action` `frames` `frames_actually_injected` `injected_at` `interrupted` `layer_note` `ok` `value_type` | 200 / 400 / 404 / 409 / 500 |
| `messagelog.list` | `categories` `label` `name` | 200 |
| `messagelog.get` | `category` `count` `messages` `total` | 200 / 400 |
| `anim.measure` | — | 200 / 400 |
| `anim.write_pose` | `saved` | 200 / 400 / 500 |
| `anim.preview` | — | 200 / 400 |
| `anim.retarget` | — | 200 / 400 |
| `cpp.list_modules` | `count` `declared_module_count` `has_code` `modules` | 200 |
| `cpp.probe` | `any_game_module_loaded` `available` `can_enable` `compile_path` `compile_path_reason` `declared_module_count` `enable_error` `enabled_by_default` `enabled_for_session` `engine_dir` `engine_source_dir` `has_code` `hot_reload` `is_compiling` `live_coding` `project_source_dir` `reloadable_package_count` `started` `unavailable_reason` | 200 |
| `cpp.add_class` | `class_name` `cpp_exists` `cpp_path` `created_files` `created_primary_module` `dependencies_added` `header_exists` `header_path` `interface_name` `marked_for_add` `module` `reloaded` `requested_name` `result` `warnings` | 200 / 400 / 409 / 500 |
| `cpp.compile` | `build_log` `build_log_path` `compilation_result` `needs_full_rebuild` `output` `reason` `result` | 400 / 409 |
| `cmd.run_python` | `dialogs` `logs` `message` `ok` `result` `type` | 400 |
| `locks.set` | `locked` | 200 |

## 폐기된 명령 (미등록, 호출하면 deny)

이 메서드들은 구버전 플러그인에 있었고 지금은 제거되었습니다. `ual_call`은 이들을 거부하고 대체
메서드를 알려줍니다. 에디터로 전달해 404를 받는 일은 없습니다.

| 폐기됨 | 대체 |
|---|---|
| `actor.destroy_batch` | removed upstream 2026-09-16. Use actor.destroy with targets.names/paths. |
| `actor_destroy_batch` | removed upstream 2026-09-16. Use actor.destroy with targets.names/paths. |
| `cancel_task` | UnrealAgentLink has no task cancellation of any kind. ual_task stops the bridge from waiting; the engine-side work keeps running on the game thread. |
| `content.get_referencers` | registered into the wrong map upstream, so it answers 404 always. Use material.get_referencers, or content.describe with include_referencers:true. |
| `editor.play` | dead alias, 404 always. Use pie.run. |
| `editor.stop` | dead alias, 404 always. Use pie.stop. |
| `log.subscribe` | not a UAL method. The editor pushes log.entry when the cvar ual.ForwardLogs is 1; ual_logs reads the ring. |
| `messagelog.subscribe` | removed upstream 2026-09-16 — log access is pull-only. Use messagelog.list, or ual_logs for this bridge’s ring. |
| `messagelog.unsubscribe` | removed upstream 2026-09-16. |
| `query_task` | UnrealAgentLink has no task polling. sequence.render_status and content.registry_status are the only progress endpoints, and both need the game thread to be free. |
| `take_screenshot` | removed upstream 2026-09-16. Use editor.screenshot. |
