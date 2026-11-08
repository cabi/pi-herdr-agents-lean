# Maintenance notes

This wrapper is thin on purpose: everything behavioral lives in upstream; only the prompt-facing texts, the merge, and the forwarding glue live here. This file records exactly what depends on what, so an upstream release can be evaluated quickly.

## Matching upstream version

| | |
|---|---|
| upstream | `pi-herdr-agents@3.8.0` (exact pin in `package.json` `dependencies`) |
| entry wrapped | `pi-herdr-agents/pi-extension/subagents/index.ts` (its default export) |
| reference capture | `upstream-inventory.json` (parent) and `upstream-inventory-child.json` (`SCENARIO=child npm run inventory`) — committed; the tests read the parent file |

Upstream registration matrix at this version:

- **Parent session** (`PI_SUBAGENT_ID` unset): all 10 tools — `subagent`, `subagent_send`, `subagent_stop`, `subagent_interrupt`, `subagent_cancel`, `subagents_list`, `subagent_resume`, `worktree_list`, `worktree_remove`, `subagents_write_task_models`.
- **Child session** (`PI_SUBAGENT_ID` set, `PI_DENY_TOOLS` honored): the deny list is only read in child sessions; the standard child env (`PI_DENY_TOOLS=subagent,subagent_interrupt`) leaves `subagent_send`, `subagent_stop`, `subagent_cancel`, `subagents_list`, `subagent_resume`.
- `worktree_list`, `worktree_remove`, `subagents_write_task_models` are parent-only (`!PI_SUBAGENT_ID`). Since 3.8.0 every tool except `subagents_write_task_models` registers with `exposure: "deferred"`, and `subagents_write_task_models` with `defaultActive: false` — irrelevant under lean (nothing upstream registers reaches pi), but it changes upstream's own active-surface count to 9 in the measure script.
- Env is read inside upstream's init function (not at import time), so re-initializing in the same process with different env — what the tests and the child scenario do — works.


3.8.0 over 3.7.2: same ten tool names and the same registration matrix, no new parameters or schema shapes — but upstream slimmed its own texts (PR #118/#119) and made routine tools **deferred**: every tool except `subagents_write_task_models` now registers with `exposure: "deferred"` (pi's `tool_search` loads them on demand), and `subagents_write_task_models` registers with `defaultActive: false`, activated via `setActiveTools` only during the `/subagents-init` flow. Descriptions/snippets/parameter descriptions are much shorter (e.g. `subagent` 1518 → 534 chars, and the snippet is no longer a verbatim duplicate), the guidelines dropped the review-family rule (moved into the `model` parameter description) and end with a placeholder catalog line (`Authenticated subagent model catalog becomes available after session start.`) that `session_start` replaces with the real catalog. Other changes pass through untouched: `stop` aborts a persistent child's leftover run (PR #121), `caller_ping` ends a persistent task (PR #120), worktree-cleanup freeze fix (PR #115), Windows bash launch (PR #112). Lean-side: `subagents_list` bullet updated (it now also lists live persistent specialists and the supervision mode — the output always did), lean `subagent` description tightened to stay under upstream's much shorter one, test harness gained `getAllTools()` (upstream's `session_start` reachability check calls it).

(Historical: 3.7.2 over 3.7.1 was declaration-identical — only `shouldAutoExitOnAgentEnd` in `maestro/adapters/pi/child/subagent-done.ts` gained a `runAborted` flag. 3.7.1 over 3.7.0 likewise: `status: "uncertain"` acknowledgements, persistent-specialist cap via `runtime.persistentReservations`, stop-failure notices, `getAgentConfigDir()` → pi's `getAgentDir()`.)

## The merge

`subagent` stays standalone (hot path). Everything else becomes an op of `subagent_ops`:

| op | upstream tool | notable schema details kept |
|---|---|---|
| `list` | `subagents_list` | no required fields |
| `interrupt` | `subagent_interrupt` | `id` or `name` |
| `cancel` | `subagent_cancel` | `id` or `name` |
| `send` | `subagent_send` | requires `message` |
| `stop` | `subagent_stop` | `id` or `name` |
| `resume` | `subagent_resume` | requires `sessionPath` |
| `worktree_list` | `worktree_list` | no required fields |
| `worktree_remove` | `worktree_remove` | requires `target` (minLength 1) |
| `write_task_models` | `subagents_write_task_models` | requires `tasks` + `tasksMeta`; parameters passed via `args` (JSON string or object) |

`help` documents any op on demand: full upstream description, parameters as pretty JSON, promptSnippet, promptGuidelines.

## What was trimmed, per tool

General rules applied: each statement once; no type/enum/length/count repetition already expressed by the schema; parameter descriptions dropped unless the field name is unclear; UI/rendering notes dropped; no MUST/NEVER/all-caps; no usage thresholds the user should decide; rules affecting how the model calls the tool kept.

| upstream tool | declaration tokens → | trimmed |
|---|---|---|
| `subagent` | 928 → 591 | upstream's own 3.8.0 text is already lean (534-char description, one-line snippet), so lean's margin is slimmer: description re-worded to ~500 chars keeping pane/worktree split, committed-HEAD base, retention, async delivery, no-poll/no-fabricate; parameter descriptions stripped, 7 short ones kept (`agent`, `skills`, `tools`, `cwd`, `fork`, `persistent`, `interactive`) plus one compact `accept` description; 7 guideline rules condensed to 4 + roster + optional task-shortlist note; the model-catalog line carried verbatim (upstream scopes it since 3.6.0 — see internals); snippet one line. Upstream's review-family rule now lives only in the `model` parameter description, which lean strips — lean keeps it as guideline rule 3. Execute-time refusals lean doesn't restate (delegation depth, self-spawn block, `accept` unsupported on persistent/non-auto-exit children) surface as encoded upstream errors |
| `subagents_write_task_models` | (inactive upstream) | since 3.8.0 `defaultActive: false`, activated only via `/subagents-init` — so it costs upstream nothing per request; under lean it's the `write_task_models` op: bullet + "`args` as a JSON string, see help", full schema only via `help` |
| `subagent_resume` | 173 → | description folded into a bullet; schema not sent at all |
| `subagent_cancel` | 146 → | behavioral rules (one result, no retry, persistent needs stop) kept as one bullet |
| `subagent_interrupt` / `subagent_send` / `subagent_stop` / `subagents_list` / `worktree_list` / `worktree_remove` | 35–93 each → | one bullet each; schemas replaced by the flat common fields |

Merged-tool schema decisions: `op` is a plain string (not an enum, not required) — the description bullets list the ops once, and a missing/unknown/ambiguous op gets an `[E_LEAN_OP]` error listing them with a help hint at execute time. Common parameters (`id`, `name`, `message`, `sessionPath`, `autoExit`, `target`, `preserve`) sit flat; everything else rides in `args`.

## Upstream internals this depends on

- **Tool names** (the capture keys): the ten names above. A rename upstream breaks the `latest` map lookups — caught immediately by the registration tests.
- **`ToolDefinition` surface**: at 3.8.0 no upstream tool defines `prepareArguments`, `outputSchema`, or `executionMode`; all routine tools set `exposure: "deferred"` and `subagents_write_task_models` sets `defaultActive: false` (both captured in the inventory since 3.8.0); `renderCall`/`renderResult` exist on `subagent`, `subagent_interrupt`, `subagent_cancel`, `subagent_resume`; `renderResult` only on `subagents_list`. `forwardExecute` calls `prepareArguments` when present and the lean `subagent` copies `executionMode`, so additions are picked up; a new renderer on a merged tool is dispatched via `details.leanOp` (lean sets it on forwarded results) with a plain-text fallback.
- **Validation order**: Pi runs `prepareArguments` → schema validation → `execute`. Lean canonicalization lives in `prepareArguments` (so fixes land before validation); upstream-schema enforcement (`@sinclair/typebox` `Value.Check` against the captured schema) happens inside `forwardExecute` before calling upstream's `execute`. Required fields like `task`/`message`/`sessionPath`/`target` therefore surface from whichever schema sees them first — behavior is identical.
- **Guidelines are a live array**: upstream's `session_start` handler builds the catalog through `sessionModelRegistry(ctx)` — `wrapPiModelRegistry(ctx.modelRegistry)`, then `scopeModelRegistryAdapter` when a scope applies (`ctx.scopedModels` refs plus the `PI_SUBAGENT_MODEL_SCOPE` env allowlist children inherit) — and splices the refreshed lines (`buildScopedModelCatalog` for scoped sessions, else `buildAuthenticatedModelCatalog(registry, 24, ...)`) into the same `subagentRoutingGuidelines` array the captured `subagent` def references. Lean re-registers its tools from a `session_start` handler registered **after** upstream's (registration order), so the rebuilt guidelines include the fresh catalog. Catalog detection: a guideline starting `Authenticated subagent model`; task-preference variant detection: a guideline containing `task-category shortlists`; roster-rule detection: a guideline starting `Before launching a new group` (markdown-table wording since 3.6.0, absent when `guidelines.launchRoster` is off — lean's roster rule follows it).
- **Model-catalog scoping is upstream-native since 3.6.0**: `sessionScopedModels(ctx, registry)` lists `ctx.scopedModels` when the session is scoped, so the catalog shows exactly the enabled set; unscoped sessions list every configured-auth model, truncated at 24 alphabetically. (Pre-3.6.0 the catalog could include account-disabled models — observed live: children spawned on disabled catalog entries failed with `403 Model access is disabled` — which is why lean used to rebuild the catalog from `ctx.scopedModels` itself; that override was dropped in the 3.7.0 sync because upstream's scoping also hides out-of-scope models from spawn-time resolution, not just from the displayed line.) Lean carries the catalog line verbatim.
- **`ctx.modelRegistry` shape**: upstream's `getAuthenticatedTaskPreferences` calls `registry.find(...)` unguarded — the test harness supplies `{ find, getAvailable, getAll, hasConfiguredAuth }`. Real Pi always provides these.
- **`setActiveTools` — upstream calls it since 3.8.0, harmlessly**: `trackDeferredTools` (pi-extension/subagents/deferred-tools.ts) records each deferred registration's parameter-schema object, and `session_start` runs `ensureReachable()`: it `getAllTools()`s and identity-matches `parameters` to decide whether to activate pi's native `tool_search` or the routine tools. Under lean nothing upstream registers reaches pi, so the identity check never matches and `ensureReachable()` returns `"none"` without touching `setActiveTools`. Second call site: `/subagents-init` passes `activateTool`/`isToolActive` into `maestro/runtime/task-model-init.ts`, which activates the `subagents_write_task_models` writer via `setActiveTools`; the proxy blocks that activation, so the init flow reports a clean cancel (`subagents_write_task_models is not an active tool`) — same as 3.7.2, where the gate already existed. The proxy block stays as the guarantee that the lean two-tool list can't change mid-session; `availableOps()` (derived from what actually registered at init) remains the truth.
- **Pass-through surface** (must remain untouched): commands `subagent`, `subagents-init`, `worktree`; renderers `subagent_ping`, `subagent_result`, `subagent_status` (registered via `registerMessageRenderer`); events `session_shutdown` ×2 + `session_start` ×1 (via `pi.on`); `pi.events.on` subscriptions ×2: `"pi-herdr-subagents:task-models:init:start:v1"` and `"pi-herdr-agents:child-busy"` (new in 3.7.0). Since 3.5.0 every tool and command registers through `withEncodedToolErrors(...)` (`tool-boundary.ts`: an `Object.create(pi)` object with wrapped `registerTool`/`registerCommand` that rethrow thrown errors as one encoded host line); since 3.8.0 the boundary wraps `trackDeferredTools(pi).api` (another `Object.create(pi)` layer recording deferred registrations) — both prototype layers sit on the lean proxy, which binds methods to the real pi object (an unbound method would lose the harness's private fields); that is also why `scripts/measure.ts` wraps the harness in its own binding proxy (`bindApi`) before booting upstream directly. Also since 3.8.0, `session_start` re-registers the `subagent` launch tool (`registerLaunchTool`) to refresh pi's copy of the guidelines — under lean that refreshes the captured def, which is exactly what lean's own re-registration then reads.
- **Upstream package `pi` field**: upstream also ships skills (`./skills`) and a gallery image; lean's `package.json` points `pi.skills` at `./node_modules/pi-herdr-agents/skills` so the `pi-herdr-agents` skill stays loadable.

## Fill-in rules (deliberately conservative)

- `op`: trim/quotes, lowercase, spaces/dashes → underscores, repeated `subagent(s)(_)` prefix stripped, exact/underscore-flattened/prefix match against **this session's** ops. A missing `op` is inferred only from unambiguous signatures: `about` → help, `sessionPath` → resume, `target`/`preserve` → worktree_remove, `args`/`tasks`/`tasksMeta` → write_task_models, `message` without `id`/`name` → send, empty args → the sole registered zero-arg op (list in child sessions). `id`/`name` alone matches four ops → clear error.
- `subagent` (spawn): null-ish `worktree` (JSON null, "null", "none", "undefined", "") dropped; non-empty string `worktree` → `{branch}`; array `skills`/`tools` → comma-joined; `thinking` lowercased when that matches the enum; `op` ∈ {spawn, subagent, create, start} dropped; any other `op` → `[E_LEAN_OP]` pointing at `subagent_ops`.

## How to upgrade

1. `npm install pi-herdr-agents@<new>` (keep the pin exact), then `npm run inventory` and `SCENARIO=child npm run inventory`.
2. Diff the regenerated `upstream-inventory*.json` against the committed ones (`git diff`). Watch for: tool name changes, new tools (decide: new bullet + op, or leave unmerged if hot-path), new required fields or enums, `promptGuidelines` rewording (lean condensed rules may need a refresh), new `ToolDefinition` members, changes to the registration conditions above — and whether the catalog or roster markers changed wording (lean derives its catalog detection and roster rule from them).
3. `npm test` — the suite pins the forwarding contract (every op reaches upstream with the right arguments, help returns the full upstream parameters, fill-ins don't misfire, tool list can't change mid-session, child scenario).
4. `npm run typecheck`.
5. `npm run measure`; update the token table in README.md and the per-tool trim table above.
6. If upstream adds another dynamic-gating path (a loader tool, another `setActiveTools` call site — 3.8.0 added the two handled above), extend the blocklist in `makeUpstreamPi` (src/index.ts) and note it here.
