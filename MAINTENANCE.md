# Maintenance notes

This wrapper is thin on purpose: everything behavioral lives in upstream; only the prompt-facing texts, the merge, and the forwarding glue live here. This file records exactly what depends on what, so an upstream release can be evaluated quickly.

## Matching upstream version

| | |
|---|---|
| upstream | `pi-herdr-agents@3.7.1` (exact pin in `package.json` `dependencies`) |
| entry wrapped | `pi-herdr-agents/pi-extension/subagents/index.ts` (its default export) |
| reference capture | `upstream-inventory.json` (parent) and `upstream-inventory-child.json` (`SCENARIO=child npm run inventory`) — committed; the tests read the parent file |

Upstream registration matrix at this version:

- **Parent session** (`PI_SUBAGENT_ID` unset): all 10 tools — `subagent`, `subagent_send`, `subagent_stop`, `subagent_interrupt`, `subagent_cancel`, `subagents_list`, `subagent_resume`, `worktree_list`, `worktree_remove`, `subagents_write_task_models`.
- **Child session** (`PI_SUBAGENT_ID` set, `PI_DENY_TOOLS` honored): the deny list is only read in child sessions; the standard child env (`PI_DENY_TOOLS=subagent,subagent_interrupt`) leaves `subagent_send`, `subagent_stop`, `subagent_cancel`, `subagents_list`, `subagent_resume`.
- `worktree_list`, `worktree_remove`, `subagents_write_task_models` are parent-only (`!PI_SUBAGENT_ID`).
- Env is read inside upstream's init function (not at import time), so re-initializing in the same process with different env — what the tests and the child scenario do — works.


3.7.1 over 3.7.0: the ten tool declarations are byte-identical (regenerated inventories differ only in version/timestamp); every change is execute-time or internal — spawn/resume acknowledgements can be `status: "uncertain"` with a `launchFailure` reason (the acquired owner stays supervised, no fallback, "do not blindly relaunch"), the persistent-specialist cap now counts in-flight acquisitions (`runtime.persistentReservations`), stop-failure notices are held/retried like completions, and `getAgentConfigDir()` now calls pi's `getAgentDir()` (which still honors `PI_CODING_AGENT_DIR`). All of it passes through the lean wrapper untouched.
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
| `subagent` | 1341 → 648 | description re-worded from 1518 chars (which upstream duplicates verbatim as its snippet) to ~950; parameter descriptions stripped, 7 short ones kept (`agent`, `skills`, `tools`, `cwd`, `fork`, `persistent`, `interactive`) plus one compact `accept` description (required `run` and bounds kept, sub-field descriptions folded in; added in upstream 3.7.0); 8 guideline rules condensed to 4 + optional task-shortlist note, roster rule derived from upstream's roster guideline; the model-catalog line carried verbatim (upstream scopes it since 3.6.0 — see internals); snippet one line. Execute-time refusals lean doesn't restate (delegation depth, self-spawn block, `accept` unsupported on persistent/non-auto-exit children) surface as encoded upstream errors |
| `subagents_write_task_models` | 743 → (in `subagent_ops`) | 2379-char schema reduced to: bullet + "`args` as a JSON string, see help"; full schema only via `help` |
| `subagent_resume` | 316 → | description folded into a bullet; schema not sent at all |
| `subagent_cancel` | 176 → | behavioral rules (one result, no retry, persistent needs stop) kept as one bullet |
| `subagent_interrupt` / `subagent_send` / `subagent_stop` / `subagents_list` / `worktree_list` / `worktree_remove` | 44–97 each → | one bullet each; schemas replaced by the flat common fields |

Merged-tool schema decisions: `op` is a plain string (not an enum, not required) — the description bullets list the ops once, and a missing/unknown/ambiguous op gets an `[E_LEAN_OP]` error listing them with a help hint at execute time. Common parameters (`id`, `name`, `message`, `sessionPath`, `autoExit`, `target`, `preserve`) sit flat; everything else rides in `args`.

## Upstream internals this depends on

- **Tool names** (the capture keys): the ten names above. A rename upstream breaks the `latest` map lookups — caught immediately by the registration tests.
- **`ToolDefinition` surface**: at 3.7.1 no upstream tool defines `prepareArguments`, `outputSchema`, or `executionMode`; `renderCall`/`renderResult` exist on `subagent`, `subagent_interrupt`, `subagent_cancel`, `subagent_resume`; `renderResult` only on `subagents_list`. `forwardExecute` calls `prepareArguments` when present and the lean `subagent` copies `executionMode`, so additions are picked up; a new renderer on a merged tool is dispatched via `details.leanOp` (lean sets it on forwarded results) with a plain-text fallback.
- **Validation order**: Pi runs `prepareArguments` → schema validation → `execute`. Lean canonicalization lives in `prepareArguments` (so fixes land before validation); upstream-schema enforcement (`@sinclair/typebox` `Value.Check` against the captured schema) happens inside `forwardExecute` before calling upstream's `execute`. Required fields like `task`/`message`/`sessionPath`/`target` therefore surface from whichever schema sees them first — behavior is identical.
- **Guidelines are a live array**: upstream's `session_start` handler builds the catalog through `sessionModelRegistry(ctx)` — `wrapPiModelRegistry(ctx.modelRegistry)`, then `scopeModelRegistryAdapter` when a scope applies (`ctx.scopedModels` refs plus the `PI_SUBAGENT_MODEL_SCOPE` env allowlist children inherit) — and splices the refreshed lines (`buildScopedModelCatalog` for scoped sessions, else `buildAuthenticatedModelCatalog(registry, 24, ...)`) into the same `subagentRoutingGuidelines` array the captured `subagent` def references. Lean re-registers its tools from a `session_start` handler registered **after** upstream's (registration order), so the rebuilt guidelines include the fresh catalog. Catalog detection: a guideline starting `Authenticated subagent model`; task-preference variant detection: a guideline containing `task-category shortlists`; roster-rule detection: a guideline starting `Before launching a new group` (markdown-table wording since 3.6.0, absent when `guidelines.launchRoster` is off — lean's roster rule follows it).
- **Model-catalog scoping is upstream-native since 3.6.0**: `sessionScopedModels(ctx, registry)` lists `ctx.scopedModels` when the session is scoped, so the catalog shows exactly the enabled set; unscoped sessions list every configured-auth model, truncated at 24 alphabetically. (Pre-3.6.0 the catalog could include account-disabled models — observed live: children spawned on disabled catalog entries failed with `403 Model access is disabled` — which is why lean used to rebuild the catalog from `ctx.scopedModels` itself; that override was dropped in the 3.7.0 sync because upstream's scoping also hides out-of-scope models from spawn-time resolution, not just from the displayed line.) Lean carries the catalog line verbatim.
- **`ctx.modelRegistry` shape**: upstream's `getAuthenticatedTaskPreferences` calls `registry.find(...)` unguarded — the test harness supplies `{ find, getAvailable, getAll, hasConfiguredAuth }`. Real Pi always provides these.
- **No loader tools / no `setActiveTools`**: at 3.7.1 upstream registers everything up front and never calls `setActiveTools` or flips tool availability mid-session. The proxy blocks `setActiveTools` regardless, so the lean two-tool list can't change mid-session; if a future upstream version tries to gate tools dynamically, the block turns it into a no-op and `availableOps()` (derived from what actually registered at init) stays the truth.
- **Pass-through surface** (must remain untouched): commands `subagent`, `subagents-init`, `worktree`; renderers `subagent_ping`, `subagent_result`, `subagent_status` (registered via `registerMessageRenderer`); events `session_shutdown` ×2 + `session_start` ×1 (via `pi.on`); `pi.events.on` subscriptions ×2: `"pi-herdr-subagents:task-models:init:start:v1"` and `"pi-herdr-agents:child-busy"` (new in 3.7.0). Since 3.5.0 every tool and command registers through `withEncodedToolErrors(pi)` (`tool-boundary.ts`: an `Object.create(pi)` object with wrapped `registerTool`/`registerCommand` that rethrow thrown errors as one encoded host line). The proxy binds methods to the real pi object — that is also what keeps the `Object.create` boundary working (an unbound method would lose the harness's private fields), and why `scripts/measure.ts` wraps the harness in its own binding proxy (`bindApi`) before booting upstream directly.
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
6. If upstream starts calling `setActiveTools` or introduces a loader tool, extend the blocklist in `makeUpstreamPi` (src/index.ts) and note it here.
