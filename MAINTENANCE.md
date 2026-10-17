# Maintenance notes

This wrapper is thin on purpose: everything behavioral lives in upstream; only the prompt-facing texts, the merge, and the forwarding glue live here. This file records exactly what depends on what, so an upstream release can be evaluated quickly.

## Matching upstream version

| | |
|---|---|
| upstream | `pi-herdr-agents@3.3.0` (exact pin in `package.json` `dependencies`) |
| entry wrapped | `pi-herdr-agents/pi-extension/subagents/index.ts` (its default export) |
| reference capture | `upstream-inventory.json` (parent) and `upstream-inventory-child.json` (`SCENARIO=child npm run inventory`) — committed; the tests read the parent file |

Upstream registration matrix at this version:

- **Parent session** (`PI_SUBAGENT_ID` unset): all 10 tools — `subagent`, `subagent_send`, `subagent_stop`, `subagent_interrupt`, `subagent_cancel`, `subagents_list`, `subagent_resume`, `worktree_list`, `worktree_remove`, `subagents_write_task_models`.
- **Child session** (`PI_SUBAGENT_ID` set, `PI_DENY_TOOLS` honored): the deny list is only read in child sessions; the standard child env (`PI_DENY_TOOLS=subagent,subagent_interrupt`) leaves `subagent_send`, `subagent_stop`, `subagent_cancel`, `subagents_list`, `subagent_resume`.
- `worktree_list`, `worktree_remove`, `subagents_write_task_models` are parent-only (`!PI_SUBAGENT_ID`).
- Env is read inside upstream's init function (not at import time), so re-initializing in the same process with different env — what the tests and the child scenario do — works.

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
| `subagent` | 1103 → 466 | description re-worded from 1518 chars (which upstream duplicates verbatim as its snippet) to ~950; parameter descriptions stripped, 7 short ones kept (`agent`, `skills`, `tools`, `cwd`, `fork`, `persistent`, `interactive`); 8 guideline rules condensed to 4 + optional task-shortlist note; the model-catalog line carried verbatim (or replaced by the scoped catalog — see internals); snippet one line |
| `subagents_write_task_models` | 743 → (in `subagent_ops`) | 2379-char schema reduced to: bullet + "`args` as a JSON string, see help"; full schema only via `help` |
| `subagent_resume` | 316 → | description folded into a bullet; schema not sent at all |
| `subagent_cancel` | 176 → | behavioral rules (one result, no retry, persistent needs stop) kept as one bullet |
| `subagent_interrupt` / `subagent_send` / `subagent_stop` / `subagents_list` / `worktree_list` / `worktree_remove` | 44–97 each → | one bullet each; schemas replaced by the flat common fields |

Merged-tool schema decisions: `op` is a plain string (not an enum, not required) — the description bullets list the ops once, and a missing/unknown/ambiguous op gets an `[E_LEAN_OP]` error listing them with a help hint at execute time. Common parameters (`id`, `name`, `message`, `sessionPath`, `autoExit`, `target`, `preserve`) sit flat; everything else rides in `args`.

## Upstream internals this depends on

- **Tool names** (the capture keys): the ten names above. A rename upstream breaks the `latest` map lookups — caught immediately by the registration tests.
- **`ToolDefinition` surface**: at 3.3.0 no upstream tool defines `prepareArguments`, `outputSchema`, or `executionMode`; `renderCall`/`renderResult` exist on `subagent`, `subagent_interrupt`, `subagent_cancel`, `subagent_resume`; `renderResult` only on `subagents_list`. `forwardExecute` calls `prepareArguments` when present and the lean `subagent` copies `executionMode`, so additions are picked up; a new renderer on a merged tool is dispatched via `details.leanOp` (lean sets it on forwarded results) with a plain-text fallback.
- **Validation order**: Pi runs `prepareArguments` → schema validation → `execute`. Lean canonicalization lives in `prepareArguments` (so fixes land before validation); upstream-schema enforcement (`@sinclair/typebox` `Value.Check` against the captured schema) happens inside `forwardExecute` before calling upstream's `execute`. Required fields like `task`/`message`/`sessionPath`/`target` therefore surface from whichever schema sees them first — behavior is identical.
- **Guidelines are a live array**: upstream's `session_start` handler calls `wrapPiModelRegistry(ctx.modelRegistry)` + `buildAuthenticatedModelCatalog(...)` and splices the refreshed catalog line into the same `subagentRoutingGuidelines` array the captured `subagent` def references. Lean re-registers its tools from a `session_start` handler registered **after** upstream's (registration order), so the rebuilt guidelines include the fresh catalog. Catalog detection: last line starting `Authenticated subagent model`; task-preference variant detection: a guideline containing `task-category shortlists`.
- **`ctx.scopedModels` (scoped catalog override)**: pi resolves `--models` / `enabledModels` into `ctx.scopedModels` (documented as empty when no scoping is configured; each entry carries the full model object). Upstream's catalog instead derives from `registry.getAvailable()` — the available snapshot, which covers every configured-auth provider and ignores `enabledModels` — truncated at 24 alphabetically, so account-disabled models appear and user picks can hide in the "… N more omitted" tail (observed live: children spawned on disabled catalog entries fail with `403 Model access is disabled`). When `ctx.scopedModels` is non-empty, lean rebuilds the catalog from that set in upstream's line format (`src/lean-text.ts` `buildScopedCatalog`; thinking levels via `@earendil-works/pi-ai` `getSupportedThinkingLevels`, which reads only `model.reasoning` + `model.thinkingLevelMap`), and rebuilds the task-category shortlists block from upstream's refreshed guideline text (`scopedShortlists`: keeps only scoped refs, drops emptied categories, omits the block entirely when nothing survives; the shortlist note in lean's guidelines is shown only when the block survives); when empty, upstream's catalog is carried verbatim. This leans on pi's `ctx.scopedModels` semantics, not on upstream internals.
- **`ctx.modelRegistry` shape**: upstream's `getAuthenticatedTaskPreferences` calls `registry.find(...)` unguarded — the test harness supplies `{ find, getAvailable, getAll, hasConfiguredAuth }`. Real Pi always provides these.
- **No loader tools / no `setActiveTools`**: at 3.3.0 upstream registers everything up front and never calls `setActiveTools` or flips tool availability mid-session. The proxy blocks `setActiveTools` regardless, so the lean two-tool list can't change mid-session; if a future upstream version tries to gate tools dynamically, the block turns it into a no-op and `availableOps()` (derived from what actually registered at init) stays the truth.
- **Pass-through surface** (must remain untouched): commands `subagent`, `subagents-init`, `worktree`; renderers `subagent_ping`, `subagent_result`, `subagent_status` (registered via `registerMessageRenderer`); events `session_shutdown` ×2, `session_start` ×1; one `pi.events.on("pi-herdr-subagents:task-models:init:start:v1")` subscription. The proxy binds methods to the real pi object, so all of these reach upstream unchanged.
- **Upstream package `pi` field**: upstream also ships skills (`./skills`) and a gallery image; lean's `package.json` points `pi.skills` at `./node_modules/pi-herdr-agents/skills` so the `pi-herdr-agents` skill stays loadable.

## Fill-in rules (deliberately conservative)

- `op`: trim/quotes, lowercase, spaces/dashes → underscores, repeated `subagent(s)(_)` prefix stripped, exact/underscore-flattened/prefix match against **this session's** ops. A missing `op` is inferred only from unambiguous signatures: `about` → help, `sessionPath` → resume, `target`/`preserve` → worktree_remove, `args`/`tasks`/`tasksMeta` → write_task_models, `message` without `id`/`name` → send, empty args → the sole registered zero-arg op (list in child sessions). `id`/`name` alone matches four ops → clear error.
- `subagent` (spawn): null-ish `worktree` (JSON null, "null", "none", "undefined", "") dropped; non-empty string `worktree` → `{branch}`; array `skills`/`tools` → comma-joined; `thinking` lowercased when that matches the enum; `op` ∈ {spawn, subagent, create, start} dropped; any other `op` → `[E_LEAN_OP]` pointing at `subagent_ops`.

## How to upgrade

1. `npm install pi-herdr-agents@<new>` (keep the pin exact), then `npm run inventory` and `SCENARIO=child npm run inventory`.
2. Diff the regenerated `upstream-inventory*.json` against the committed ones (`git diff`). Watch for: tool name changes, new tools (decide: new bullet + op, or leave unmerged if hot-path), new required fields or enums, `promptGuidelines` rewording (lean condensed rules may need a refresh), new `ToolDefinition` members, changes to the registration conditions above — and whether upstream now scopes its own catalog to enabled models (then the `ctx.scopedModels` override in src/index.ts can be dropped).
3. `npm test` — the suite pins the forwarding contract (every op reaches upstream with the right arguments, help returns the full upstream parameters, fill-ins don't misfire, tool list can't change mid-session, child scenario).
4. `npm run typecheck`.
5. `npm run measure`; update the token table in README.md and the per-tool trim table above.
6. If upstream starts calling `setActiveTools` or introduces a loader tool, extend the blocklist in `makeUpstreamPi` (src/index.ts) and note it here.
