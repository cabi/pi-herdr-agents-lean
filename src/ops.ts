/**
 * Op table and argument canonicalization for the merged `subagent_ops` tool.
 *
 * Upstream tool names map to short op values (models type less and the enum
 * stays small). Canonicalization runs in `prepareArguments`, before schema
 * validation: fix only what can't be wrong (casing, separators, a redundant
 * `subagent`/`subagents` prefix, an op uniquely implied by the arguments);
 * anything ambiguous is left for validation or a clear error.
 */

/** Upstream tool name -> merged op value. */
export const OP_BY_TOOL = {
	subagent_interrupt: "interrupt",
	subagent_cancel: "cancel",
	subagent_send: "send",
	subagent_stop: "stop",
	subagents_list: "list",
	subagent_resume: "resume",
	worktree_list: "worktree_list",
	worktree_remove: "worktree_remove",
	subagents_write_task_models: "write_task_models",
} as const;

export type SubagentOp = (typeof OP_BY_TOOL)[keyof typeof OP_BY_TOOL] | "help";

export type UpstreamToolName = keyof typeof OP_BY_TOOL;

/** All ops, help included, in a stable order. */
export const ALL_OPS: readonly SubagentOp[] = [
	"help",
	"list",
	"interrupt",
	"cancel",
	"send",
	"stop",
	"resume",
	"worktree_list",
	"worktree_remove",
	"write_task_models",
];

/** Upstream tool name for an op (null for help). */
export function toolForOp(op: SubagentOp): UpstreamToolName | null {
	if (op === "help") return null;
	return (Object.keys(OP_BY_TOOL) as UpstreamToolName[]).find(
		(key) => OP_BY_TOOL[key] === op,
	) ?? null;
}

/**
 * Canonicalize an op value against the available ops.
 *
 * Trim; strip surrounding quotes/backticks; lowercase; spaces and dashes to
 * underscores; drop redundant subagent/subagents prefixes. Exact match wins;
 * otherwise compare underscore-flattened forms (exact, then unambiguous
 * prefix/inclusion at 3+ chars). Returns the input unchanged when empty,
 * non-string, or not uniquely matched.
 */
export function canonicalizeOp(
	raw: unknown,
	available: readonly SubagentOp[],
): string | typeof raw {
	if (typeof raw !== "string") return raw;
	const trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, "");
	if (!trimmed) return raw;
	let norm = trimmed.toLowerCase().replace(/[\s-]+/g, "_");
	for (let prev = ""; prev !== norm; ) {
		prev = norm;
		norm = norm.replace(/^(subagents?_|subagents$|subagent$)/, "");
	}
	if (available.includes(norm as SubagentOp)) return norm;
	const flat = norm.replace(/_/g, "");
	const flatAvailable = available.map((o) => o.replace(/_/g, ""));
	const exact = available.find((_, i) => flatAvailable[i] === flat);
	if (exact) return exact;
	if (flat.length >= 3) {
		const hits = available.filter(
			(_, i) => flatAvailable[i].startsWith(flat) || flatAvailable[i].includes(flat),
		);
		if (hits.length === 1) return hits[0];
	}
	return raw;
}

/**
 * Infer the op from the arguments when `op` is missing. Only unambiguous
 * signatures are inferred; null means "no unique answer" and the caller
 * returns a clear error instead of guessing.
 */
export function inferOp(
	args: Record<string, unknown> | null | undefined,
	available: readonly SubagentOp[],
): SubagentOp | null {
	const has = (...keys: string[]) => keys.some((k) => args?.[k] !== undefined);
	if (has("about")) return "help";
	if (has("sessionPath")) return "resume";
	if (has("target", "preserve")) return "worktree_remove";
	if (has("args", "tasks", "tasksMeta")) return "write_task_models";
	if (has("message") && !has("id", "name")) return "send";
	if (!args || Object.keys(args).length === 0) {
		// Zero-argument ops: list and worktree_list. Unique when only one is
		// registered in this session (a subagent child session has list only).
		const zeroArg = (["list", "worktree_list"] as SubagentOp[]).filter((op) =>
			available.includes(op),
		);
		if (zeroArg.length === 1) return zeroArg[0];
		return null;
	}
	// id/name-only arguments match interrupt, cancel, send, and stop.
	return null;
}

/**
 * Canonicalize `subagent_ops` arguments: fix or infer `op` when unique.
 * Leaves everything else untouched.
 */
export function canonicalizeOpsArgs(
	args: unknown,
	available: readonly SubagentOp[],
): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const record = { ...(args as Record<string, unknown>) };
	const op = record.op;
	if (typeof op === "string") {
		const canonical = canonicalizeOp(op, available);
		if (canonical !== op) record.op = canonical;
		return record;
	}
	const inferred = inferOp(record, available);
	if (inferred) record.op = inferred;
	return record;
}

/**
 * Canonicalize `subagent` (spawn) arguments: fix only can't-be-wrong slips.
 * - `worktree` given as a non-empty branch-name string becomes {branch}.
 * - `skills`/`tools` given as arrays become the comma-separated string form.
 * - `thinking` casing normalized against the lowercase enum values.
 * - a `op: "spawn"|"subagent"|"create"|"start"` field is dropped (the model
 *   clearly meant the spawn operation itself); any other `op` value is left
 *   in place so `execute` can point at the `subagent_ops` tool.
 */
export function canonicalizeSpawnArgs(args: unknown, thinkingEnum: readonly string[]): unknown {
	if (!args || typeof args !== "object" || Array.isArray(args)) return args;
	const record = { ...(args as Record<string, unknown>) };
	if (typeof record.worktree === "string" && record.worktree.trim() !== "") {
		record.worktree = { branch: record.worktree };
	}
	for (const key of ["skills", "tools"] as const) {
		const value = record[key];
		if (Array.isArray(value)) record[key] = value.map(String).join(",");
	}
	if (typeof record.thinking === "string") {
		const lower = record.thinking.toLowerCase();
		if (thinkingEnum.includes(lower)) record.thinking = lower;
	}
	if (
		record.op === "spawn" ||
		record.op === "subagent" ||
		record.op === "create" ||
		record.op === "start"
	) {
		delete record.op;
	}
	return record;
}
