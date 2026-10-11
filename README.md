# pi-herdr-agents-lean

A token-lean wrapper around [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents), the Pi coding-agent extension for supervised subagents, managed worktrees, and model routing.

**Based on [pi-herdr-agents](https://github.com/giuseppecrj/pi-herdr-agents) by Giuseppe Rodriguez ([giuseppecrj](https://github.com/giuseppecrj)).** Original license: MIT (see [LICENSE](./LICENSE), copyright HazAT, preserved verbatim).

The lean-wrapper approach comes from [Make your own lean version](https://github.com/kunkun9527/my-lean-pi-setup/blob/main/docs/make-your-own-lean.md) in [kunkun9527/my-lean-pi-setup](https://github.com/kunkun9527/my-lean-pi-setup) — the source of the idea, with the reasoning and side-by-side examples in the article [Cut 91% of your tool prompts: a practical guide for Pi Agent users and extension authors](https://dev.to/shengkai_su/cut-91-of-your-tool-prompts-a-practical-guide-for-pi-agent-users-and-extension-authors-4jo9).

Every upstream feature is kept exactly as-is — same commands, same renderers, same events, same execute behavior. Upstream is installed as a pinned, exact-version dependency (`pi-herdr-agents@3.2.1`); no upstream code is copied or modified. The only change is what the model reads on every request: tool descriptions, parameter schemas, snippets, and guidelines are re-worded and deduplicated, and nine rarely-used tools are merged into one.

## How it works

The extension initializes upstream against a `Proxy` of Pi's extension API:

- `registerTool` is intercepted. Upstream tool definitions are captured, never registered. Two lean tools are registered instead:
  - **`subagent`** — the hot-path spawn tool, kept standalone, with a lean description and schema (upstream's contract preserved: same required fields, same enums; plus a `worktree: "branch-name"` string shorthand).
  - **`subagent_ops`** — the nine remaining upstream tools merged behind an `op` parameter (list, interrupt, cancel, send, stop, resume, worktree_list, worktree_remove, write_task_models) plus `op: help`. Common parameters sit flat in the schema; write_task_models' parameters ride in `args` as a JSON string.
- `setActiveTools` is blocked. Upstream never calls it today; the guard keeps the lean two-tool list fixed for the whole session in either case.
- Everything else — slash commands (`/subagent`, `/subagents-init`, `/worktree`), message renderers (`subagent_ping`, `subagent_result`, `subagent_status`), session events — passes through untouched.
- Calls still validate against the **captured upstream schema** before execute, so upstream's contract (required fields, enums, patterns) keeps holding even though the model only sees the lean schema.
- `op: help` (with `about: <op>`) returns the full upstream description, parameter schema, snippet, and guidelines for that op, so nothing is lost — it's fetched on demand instead of prepaid on every request.

The op set mirrors what upstream registered in this process: parent sessions get all ops; subagent child sessions (`PI_SUBAGENT_ID`) get the reduced child set; `PI_DENY_TOOLS` removes individual tools from both.

Small, can't-be-wrong call slips are fixed before validation (op casing/prefix/underscores, a uniquely-implied op, array `skills`/`tools`, `worktree` string shorthand, thinking-level casing). Anything ambiguous returns a `[E_LEAN_*]` error naming the valid ops instead of guessing.

## Token cost

Measured with `npm run measure` (js-tiktoken `o200k_base`, parent session, session_start applied). Counts what the model reads on every request while the tools are active: tool declarations (`{name, description, parameters}`), one snippet line per tool, and deduplicated guideline rules.

| per-tool declarations | upstream tokens | lean tokens |
|---|---:|---:|
| subagent | 1103 | 466 |
| subagent_resume | 316 | |
| subagents_write_task_models | 743 | |
| subagent_cancel | 176 | |
| subagent_interrupt | 97 | |
| subagent_send | 88 | |
| subagent_stop | 70 | |
| worktree_remove | 95 | |
| worktree_list | 48 | |
| subagents_list | 44 | |
| subagent_ops (merged) | | 527 |

| | upstream (10 tools) | lean (2 tools) |
|---|---:|---:|
| declarations | 13316 chars / 2780 tokens | 4335 chars / 993 tokens |
| snippets | 3555 chars / 715 tokens | 242 chars / 64 tokens |
| guidelines | 8 rules / 577 tokens | 5 rules / 443 tokens |
| **total** | **19825 chars / 4072 tokens** | **6879 chars / 1500 tokens** |

**Saved: 2572 tokens per request (63.2%).** The authenticated-model-catalog guideline line is carried over verbatim (it grows with your registry in real sessions, identically for both).

## Errors

| Code | Meaning |
|---|---|
| `[E_LEAN_OP]` | op missing/ambiguous, unknown, or unavailable in this session; message lists the valid ops |
| `[E_LEAN_ARGS]` | forwarded arguments fail upstream's schema, or `args` used on the wrong op |
| `[E_LEAN_HELP_ABOUT]` | `about` names no known op |
| `[E_LEAN_UNAVAILABLE]` | op's upstream tool isn't registered in this session |

## Keeping up with upstream

Pin the upstream version and upgrade by hand. The process is nearly always the same, so you can hand it to an agent too (this is the sync prompt from [Make your own lean version](https://github.com/kunkun9527/my-lean-pi-setup/blob/main/docs/make-your-own-lean.md), with this package's names filled in):

```text
Sync pi-herdr-agents-lean to the latest version of upstream pi-herdr-agents.

1. Read MAINTENANCE.md first to understand the current upstream version and adaptation points.
2. Check the latest upstream version. Compare the code and changelog between the two versions, and list: added or removed tools, changes to parameters and defaults, behavior changes, and whether the internals recorded in MAINTENANCE.md still hold.
3. If only the version number changed and the code didn't, just upgrade the dependency.
4. For new parameters or tools, add them to the lean version using the same trimming rules: common ones go in the schema, rare ones go in help. If upstream changed behavior, update the descriptions so they still match what the tool does.
5. Run the tests, re-measure the tokens, and update the README and MAINTENANCE.md.
6. Summarize the changes for me, and only publish after I confirm.
```

Most upstream updates only change internal logic, so upgrading the dependency is all it takes. When the adapter does need changes, it's usually because upstream renamed a tool or changed parameters.

## Development

```sh
npm install
npm test            # 31 tests: forwarding, help, fill-ins, stability, child sessions
npm run typecheck
npm run inventory   # regenerate upstream-inventory.json (+ SCENARIO=child for the child file)
npm run measure     # token table above
```

Upstream internals this wrapper depends on, per-tool trim notes, and upgrade steps: [MAINTENANCE.md](./MAINTENANCE.md).
