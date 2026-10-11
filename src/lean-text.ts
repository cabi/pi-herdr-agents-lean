/**
 * Lean prompt text and schemas for the two lean tools.
 *
 * Everything here is re-worded from upstream semantics, one statement per
 * rule: no type/enum/count repetition the schema already carries, no caps
 * emphasis, no usage thresholds the user should decide. See MAINTENANCE.md
 * for the per-tool trim table.
 *
 * Dynamic parts (the authenticated model catalog line, the task-preference
 * variant marker) are read from the live upstream guidelines array at build
 * time, so lean and upstream always agree after session_start.
 */

import type { SubagentOp } from "./ops.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// subagent (spawn)
// ---------------------------------------------------------------------------

export function leanSubagentDescription(): string {
	return [
		"Spawn a sub-agent in a dedicated pane, or in an isolated managed Git worktree when `worktree` is set. Fire-and-forget: the call returns an acknowledgement immediately and the result arrives later as a steer message that starts a new turn — end the turn or do other work in the meantime; don't poll for completion (loops, sleep, tail, status checks) and don't fabricate results.",
		"Ordinary panes for read-only tasks; a single sequential writer can work in the parent checkout. Parallel independent writers each get a worktree branched from committed HEAD, so uncommitted parent changes are not copied. A finished worktree run keeps its workspace for review (nothing is pushed, merged, or removed); inspect it by spawning a read-only agent with `cwd` set to that worktree path rather than creating a new worktree.",
	].join("\n\n");
}

export const LEAN_SUBAGENT_SNIPPET =
	"Spawn a sub-agent in a pane or managed worktree; async — the result arrives as a new turn";

/**
/**
 * Lean routing guidelines. `upstreamGuidelines` is the live array from the
 * captured upstream `subagent` def. The model catalog is `scopedCatalog`
 * (built from ctx.scopedModels) when the session scopes models; otherwise
 * the upstream catalog line (last line starting with
 * "Authenticated subagent model") is carried over verbatim. The
 * task-preferences variant gets its shortlist note.
 */
export function leanSubagentGuidelines(
	upstreamGuidelines: readonly string[] | undefined,
	scopedCatalog?: string | null,
): string[] {
	const catalog = (upstreamGuidelines ?? []).find((g) =>
		g.startsWith("Authenticated subagent model"),
	);
	const hasPreferences = (upstreamGuidelines ?? []).some((g) =>
		g.includes("task-category shortlists"),
	);
	const rules = [
		"Coordinate subagent work: give each child one bounded outcome — goal, allowed files, verification, whether to commit — keep dependent writes sequential, parallelize only independent tasks. Children are leaves: no pushing, merging, deploying, or orchestrating further agents unless the task authorizes it; the parent owns integration and verification.",
		"Set both `model` and `thinking` per child: an exact authenticated provider/model-id (never an alias), `task:<category>` to expand configured candidates, or a comma-separated fallback list (worktrees use only the first entry; fallback lists don't combine with worktrees). Match thinking to difficulty: minimal/low for mechanical work, medium for ordinary implementation or review, high+ for architecture, security, hard diagnosis. Omitting both inherits the parent runtime — a discouraged fallback for orchestrated children.",
		"Ordinary review prefers a different authenticated model family; a same-family reviewer in a fresh standalone session is a last resort — disclose that isolation, and never use it for cross-family verification.",
		"Name a new coordinated group <task>-<role>[-n] (roles such as plan, research, ui, api, build, test, review, browser, security, perf, merge); after the final launch print name | agent kind | role | model | worktree, and use those names in prompts, handoffs, and results.",
	];
	if (hasPreferences) {
		rules.push(
			"Prefer the configured task-category shortlists when choosing child models.",
		);
	}
	if (scopedCatalog) rules.push(scopedCatalog);
	else if (catalog) rules.push(catalog);
	return rules;
}

// ---------------------------------------------------------------------------
// Scoped model catalog (ctx.scopedModels)
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of pi's ScopedModel: the full model object plus an
 * optional thinking level pinned by the pattern ("model:high").
 */
export interface ScopedModelLike {
	model: {
		provider: string;
		id: string;
		reasoning?: boolean;
		input?: readonly string[];
		contextWindow?: number;
		maxTokens?: number;
		thinkingLevelMap?: Record<string, unknown>;
	};
}

function tokenCount(value: number | undefined): string {
	if (!value) return "";
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

/**
 * Catalog of the session's scoped models (pi resolves enabledModels / --models
 * into ctx.scopedModels). Upstream's own catalog lists every model of every
 * configured-auth provider — including ones disabled at the provider, which
 * children then fail to spawn with — and truncates at 24 alphabetically,
 * which can hide the user's actual picks. This lists exactly the scoped set,
 * in upstream's line format (thinking levels via pi-ai's
 * getSupportedThinkingLevels, like upstream's catalog builder).
 */
export function buildScopedCatalog(
	scopedModels: readonly ScopedModelLike[],
): string {
	const seen = new Set<string>();
	const models = scopedModels
		.map((entry) => entry?.model)
		.filter((model): model is ScopedModelLike["model"] => {
			if (!model?.provider || !model?.id) return false;
			const ref = `${model.provider}/${model.id}`;
			if (seen.has(ref)) return false;
			seen.add(ref);
			return true;
		})
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	const lines = [
		"Authenticated subagent models enabled in this session (use exact provider/model-id only):",
	];
	for (const model of models) {
		const supported = getSupportedThinkingLevels(model as any);
		const facts = [
			model.reasoning
				? `reasoning (${supported.join("/") || "no thinking levels"})`
				: "non-reasoning",
			model.input?.includes("image") ? "text+image" : "text",
			tokenCount(model.contextWindow)
				? `${tokenCount(model.contextWindow)} context`
				: undefined,
			tokenCount(model.maxTokens)
				? `${tokenCount(model.maxTokens)} max output`
				: undefined,
		].filter(Boolean);
		lines.push(`- ${model.provider}/${model.id} — ${facts.join(", ")}`);
	}
	return lines.join("\n");
}

/**
 * Lean `subagent` schema: upstream's captured schema with parameter
 * descriptions stripped, the worktree branch-name shorthand added, and a
 * short description kept only where the field name alone is unclear.
 */
export function leanSubagentSchema(upstreamSchema: any): any {
	const stripped = stripParamDescriptions(upstreamSchema);
	const props = stripped.properties;
	if (props?.worktree?.anyOf) {
		props.worktree.anyOf = [
			{ type: "string", minLength: 1 },
			...props.worktree.anyOf,
		];
	}
	if (props?.agent) props.agent.description = "role name (project, global, then role packs)";
	if (props?.skills) props.skills.description = "comma-separated list";
	if (props?.tools) props.tools.description = "comma-separated list";
	if (props?.cwd) props.cwd.description = "start folder; the source repo when worktree is set";
	if (props?.fork) props.fork.description = "true = full-context fork, false = standalone";
	if (props?.persistent)
		props.persistent.description = "specialist kept alive between tasks";
	if (props?.interactive)
		props.interactive.description = "user-driven pane; parent not woken on stall/recovery";
	return stripped;
}

// ---------------------------------------------------------------------------
// subagent_ops (merged tool)
// ---------------------------------------------------------------------------

const OPS_BULLETS: Record<Exclude<SubagentOp, "help">, string> = {
	list: "list package, global, and project agent definitions (project overrides global, which overrides package)",
	interrupt: "send Escape to a running subagent's active turn (`id` or `name`); pane, session, and entry stay alive",
	cancel: "cancel a running ordinary subagent (`id` or `name`); one cancelled result is delivered, no retry or recovery; persistent specialists need `stop`",
	send: "deliver one follow-up task (`message`, plus `id` or `name`) to an idle persistent specialist; busy ones reject it and nothing is queued",
	stop: "gracefully stop a persistent specialist after its active task settles",
	resume: "resume a session .jsonl in a new pane (`sessionPath`); fire-and-forget like spawn; a worktree-bound child continues in its existing workspace",
	worktree_list: "inventory of managed worktrees, including cross-session orphans; read-only",
	worktree_remove: "remove one managed worktree by exact path, branch, or workspace id (`target`); branches and commits are kept; dirty work needs `preserve: true` for a WIP commit",
	write_task_models: "atomically replace models.tasks / models.tasksMeta in the durable agent config (categories: coding, review, recon, qa, architecture, docs); parameters go in `args` as a JSON string; see `help` for the full schema",
};

export function leanOpsDescription(available: readonly SubagentOp[]): string {
	const bullets = available
		.filter((op): op is Exclude<SubagentOp, "help"> => op !== "help")
		.map((op) => `- ${op}: ${OPS_BULLETS[op]}`);
	bullets.push("- help: full upstream documentation and parameters for one op (`about`), or a summary of all ops");
	return [
		`Subagent lifecycle ops. Set \`op\` to the operation and pass that operation's parameters flat (\`id\`, \`name\`, \`message\`, \`sessionPath\`, \`autoExit\`, \`target\`, \`preserve\`); write_task_models takes its parameters in \`args\` as a JSON string. The op is inferred when the arguments match exactly one operation.`,
		bullets.join("\n"),
	].join("\n\n");
}

export function leanOpsSnippet(available: readonly SubagentOp[]): string {
	const ops = available.filter((op) => op !== "help");
	return `Subagent ops via \`op\`: ${ops.join(", ")}${ops.length ? ", help" : "help"}`;
}

/**
 * Schema for the merged `subagent_ops` tool: common parameters flat, the
 * op values documented in the description bullets (no enum — a typo or
 * missing op gets a clear error listing the ops at execute time), and
 * write_task_models' parameters carried in `args`.
 */
export function leanOpsSchema(_available: readonly SubagentOp[]): any {
	return {
		type: "object",
		additionalProperties: true,
		properties: {
			op: { type: "string", minLength: 1 },
			about: { type: "string", description: "op name to document (help)" },
			id: { type: "string" },
			name: { type: "string" },
			message: { type: "string" },
			sessionPath: { type: "string" },
			autoExit: { type: "boolean", description: "exit after the resumed response completes" },
			target: { type: "string", minLength: 1 },
			preserve: { type: "boolean" },
			args: {
				description: "write_task_models parameters as a JSON string",
				anyOf: [{ type: "string" }, { type: "object" }],
			},
		},
	};
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/**
 * Recursively drop `description` fields from a JSON schema, keeping names,
 * types, enums, and constraints. Used on captured upstream schemas.
 */
export function stripParamDescriptions(schema: unknown): any {
	if (Array.isArray(schema)) return schema.map(stripParamDescriptions);
	if (schema && typeof schema === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
			if (key === "description") continue;
			out[key] = stripParamDescriptions(value);
		}
		return out;
	}
	return schema;
}

/** Thinking enum values of the upstream `subagent` schema, for casing fixes. */
export function thinkingEnumOf(upstreamSchema: any): string[] {
	const anyOf = upstreamSchema?.properties?.thinking?.anyOf;
	if (!Array.isArray(anyOf)) return [];
	return anyOf
		.map((sub: any) => sub?.const)
		.filter((value: unknown): value is string => typeof value === "string");
}
