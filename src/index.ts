/**
 * pi-herdr-agents-lean
 *
 * Token-lean wrapper around pi-herdr-agents (pinned exact-version
 * dependency; no upstream code copied or modified). Upstream initializes
 * against a Proxy around the pi extension API:
 *
 * - `registerTool` is intercepted: upstream definitions are captured in a
 *   `latest` map and never registered directly. Two lean tools are
 *   registered instead — `subagent` (the hot-path spawn tool, kept
 *   standalone) and `subagent_ops` (the remaining tools merged behind an
 *   `op` parameter plus `help`) — with lean descriptions/schemas while
 *   execute/render plumbing forwards to the captured definitions.
 * - `setActiveTools` is intercepted and blocked: the lean tool list is
 *   registered once and stays fixed for the whole session. Upstream never
 *   calls it today; the guard keeps that true after upgrades.
 * - everything else (slash commands, message renderers, session events,
 *   pi.events subscriptions) passes through to the real pi object
 *   unchanged, so every non-tool feature behaves exactly like upstream.
 *
 * The op set mirrors what upstream registered in this process: parent
 * sessions get all ops, subagent child sessions (PI_SUBAGENT_ID) get the
 * reduced child set, and PI_DENY_TOOLS removes individual tools from both.
 *
 * At session_start (after upstream's own handler has spliced the live
 * model-catalog line into the upstream guidelines) the lean tools are
 * re-registered under the same names with refreshed texts — the names the
 * model sees never change mid-session. When pi resolved model scoping
 * (enabledModels / --models) into ctx.scopedModels, the guidelines' model
 * catalog is rebuilt from that scoped set instead of upstream's
 * all-authenticated list, so children are only offered models the user
 * enabled.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Value } from "@sinclair/typebox/value";
import upstream from "pi-herdr-agents/pi-extension/subagents/index.ts";
import {
	ALL_OPS,
	OP_BY_TOOL,
	canonicalizeOp,
	canonicalizeOpsArgs,
	canonicalizeSpawnArgs,
	toolForOp,
	type SubagentOp,
	type UpstreamToolName,
} from "./ops.ts";
import {
	LEAN_SUBAGENT_SNIPPET,
	leanOpsDescription,
	leanOpsSchema,
	leanOpsSnippet,
	leanSubagentDescription,
	buildScopedCatalog,
	leanSubagentGuidelines,
	leanSubagentSchema,
	thinkingEnumOf,
} from "./lean-text.ts";

type AnyToolDefinition = ToolDefinition<any, any, any>;

/** Most recently captured upstream definition per tool name. */
const latest = new Map<string, AnyToolDefinition>();

let realPi: ExtensionAPI | null = null;

/** Ops available here: one per captured tool plus help. */
function availableOps(): SubagentOp[] {
	return ALL_OPS.filter((op) => op === "help" || latest.has(toolForOp(op)!));
}

// ---------------------------------------------------------------------------
// Proxy around the pi object handed to upstream
// ---------------------------------------------------------------------------

export function makeUpstreamPi(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, prop) {
			if (prop === "registerTool") {
				return (def: AnyToolDefinition) => {
					latest.set(def.name, def);
				};
			}
			if (prop === "setActiveTools") {
				// Block tool-list mutations: the lean pair is registered once and
				// must stay the surface the model sees for the whole session.
				return (_names: string[]) => {
					// Deliberately not forwarded.
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function"
				? (value as (...a: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}

// ---------------------------------------------------------------------------
// Forwarding
// ---------------------------------------------------------------------------

/** Fail loudly (and lean-specifically) instead of guessing. */
function leanError(message: string): never {
	throw new Error(message);
}

/**
 * Forward a call to the most recently captured upstream definition after
 * validating the arguments against that tool's own captured schema, so the
 * upstream contract (required fields, enums, patterns) still holds even
 * though pi validated only the lean schema.
 */
async function forwardExecute(
	toolName: string,
	toolCallId: string,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<any>> {
	const def = latest.get(toolName);
	if (!def) {
		leanError(
			`[E_LEAN_UNAVAILABLE] The ${toolName} operation is not registered in this session. Available ops: ${availableOps().join(", ")}.`,
		);
	}
	if (def.parameters && !Value.Check(def.parameters as any, args)) {
		const errors = [...Value.Errors(def.parameters as any, args)]
			.map((e) => `${e.path || "(root)"}: ${e.message}`)
			.join("; ");
		leanError(
			`[E_LEAN_ARGS] Invalid arguments for op ${OP_BY_TOOL[toolName as UpstreamToolName] ?? toolName}: ${errors}. Use op: help with about: ${OP_BY_TOOL[toolName as UpstreamToolName] ?? toolName} for the full parameter documentation.`,
		);
	}
	const prepared = def.prepareArguments ? def.prepareArguments(args) : args;
	return def.execute(toolCallId, prepared, signal, onUpdate, ctx);
}

/** Tag a forwarded result so lean renderResult can dispatch to the right renderer. */
function tagLeanOp(result: AgentToolResult<any>, op: string): AgentToolResult<any> {
	if (result && typeof result === "object" && result.details && typeof result.details === "object") {
		try {
			(result.details as Record<string, unknown>).leanOp = op;
		} catch {
			// frozen/exotic details object — renderer falls back to the op field
		}
	}
	return result;
}

function textOfResult(result: any): string {
	if (typeof result?.content === "string") return result.content;
	if (Array.isArray(result?.content)) {
		return result.content.map((c: any) => (typeof c === "string" ? c : c?.text ?? "")).join("\n");
	}
	return "";
}

// ---------------------------------------------------------------------------
// subagent_ops: help + op dispatch
// ---------------------------------------------------------------------------

function opOf(raw: unknown): SubagentOp | string {
	return canonicalizeOp(raw, availableOps()) as SubagentOp | string;
}

function helpResult(aboutRaw: unknown): AgentToolResult<any> {
	const ops = availableOps();
	if (typeof aboutRaw === "string" && aboutRaw.trim()) {
		const op = opOf(aboutRaw);
		if (!ops.includes(op as SubagentOp)) {
			leanError(
				`[E_LEAN_HELP_ABOUT] Unknown 'about' op: ${JSON.stringify(aboutRaw)}. Use one of: ${ops.join(", ")}.`,
			);
		}
		const toolName = toolForOp(op as SubagentOp);
		const def = toolName ? latest.get(toolName) : undefined;
		if (!def) {
			leanError(`[E_LEAN_NOT_READY] No upstream definition captured for ${op} yet; retry shortly.`);
		}
		const parts: string[] = [
			`# subagent_ops op \`${String(op)}\` — full upstream documentation`,
			"",
			"## description",
			String(def.description),
			"",
			"## parameters",
			"```json",
			JSON.stringify(def.parameters, null, 2),
			"```",
		];
		if (def.promptSnippet) parts.push("", "## promptSnippet", String(def.promptSnippet));
		if (def.promptGuidelines?.length) {
			parts.push("", "## promptGuidelines", ...def.promptGuidelines.map((g) => `- ${g}`));
		}
		return {
			content: [{ type: "text", text: parts.join("\n") }],
			details: { leanHelp: op },
		};
	}
	const lines = ops.map((op) => {
		if (op === "help") return "- help: full upstream documentation and parameters for one op (set `about`)";
		const def = latest.get(toolForOp(op)!);
		const summary = def?.promptSnippet ?? def?.description ?? "";
		return `- ${op}: ${summary.split("\n")[0]}`;
	});
	return {
		content: [
			{
				type: "text",
				text: `subagent_ops — set 'op' to one of: ${ops.join(", ")}. Set 'about' for full upstream docs on any op.\n${lines.join("\n")}`,
			},
		],
		details: { leanHelp: "list" },
	};
}

/** Pick the common flat fields that belong to this op and merge write_task_models' `args`. */
function forwardedOpsArgs(op: SubagentOp, args: Record<string, unknown>): Record<string, unknown> {
	const pick = (keys: string[]) =>
		Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
	if (op === "write_task_models") {
		const raw = args.args;
		let parsed: unknown = raw;
		if (typeof raw === "string") {
			try {
				parsed = JSON.parse(raw);
			} catch (error) {
				leanError(
					`[E_LEAN_ARGS] 'args' must be a JSON object string (write_task_models parameters). Parse error: ${(error as Error).message}`,
				);
			}
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			leanError("[E_LEAN_ARGS] 'args' must decode to a JSON object (write_task_models parameters).");
		}
		const direct = pick(["tasks", "tasksMeta", "expectedConfigRevision", "basis"]);
		return { ...(parsed as Record<string, unknown>), ...direct };
	}
	if (args.args !== undefined) {
		leanError(
			`[E_LEAN_ARGS] 'args' is only used by op write_task_models; pass op ${op}'s parameters directly.`,
		);
	}
	return pick(["id", "name", "message", "sessionPath", "autoExit", "target", "preserve"]);
}

async function opsExecute(
	toolCallId: string,
	args: any,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<any>> {
	const ops = availableOps();
	const op = opOf(args?.op);
	if (op === "help") return helpResult(args?.about);
	if (!ops.includes(op as SubagentOp)) {
		if (typeof op === "string" && op) {
			const known = ALL_OPS.includes(op as SubagentOp);
			leanError(
				known
					? `[E_LEAN_OP] Op ${op} is not available in this session. Available ops: ${ops.join(", ")}.`
					: `[E_LEAN_OP] Unknown op ${JSON.stringify(op)}. Available ops: ${ops.join(", ")}. Use op: help with about: <op> for full documentation.`,
			);
		}
		leanError(
			`[E_LEAN_OP] Missing or ambiguous 'op' (the arguments match several ops). Set 'op' to one of: ${ops.join(", ")}.`,
		);
	}
	const toolName = toolForOp(op as SubagentOp)!;
	const forwarded = forwardedOpsArgs(op as SubagentOp, (args ?? {}) as Record<string, unknown>);
	const result = await forwardExecute(toolName, toolCallId, forwarded, signal, onUpdate, ctx);
	return tagLeanOp(result, op as string);
}

function opsRenderCall(args: any, theme: any, context: any): any {
	const op = canonicalizeOp(args?.op, availableOps());
	const toolName = typeof op === "string" ? toolForOp(op as SubagentOp) : null;
	const def = toolName ? latest.get(toolName) : undefined;
	if (def?.renderCall) return def.renderCall(args, theme, context);
	return new Text(`subagent_ops ${typeof args?.op === "string" ? args.op : "(no op)"}`, 0, 0);
}

function opsRenderResult(result: any, options: any, theme: any, context: any): any {
	const op = result?.details?.leanOp;
	const toolName = typeof op === "string" ? toolForOp(op as SubagentOp) : null;
	const def = toolName ? latest.get(toolName) : undefined;
	if (def?.renderResult) return def.renderResult(result, options, theme, context);
	return new Text(textOfResult(result), 0, 0);
}

// ---------------------------------------------------------------------------
// subagent (spawn) forwarding
// ---------------------------------------------------------------------------

async function subagentExecute(
	toolCallId: string,
	args: any,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<any> | undefined,
	ctx: ExtensionToolContext,
): Promise<AgentToolResult<any>> {
	if (args?.op !== undefined) {
		leanError(
			`[E_LEAN_OP] The subagent tool spawns directly; for op ${JSON.stringify(args.op)} use the subagent_ops tool.`,
		);
	}
	const def = latest.get("subagent");
	if (!def) {
		leanError("[E_LEAN_UNAVAILABLE] The subagent tool is not registered in this session.");
	}
	if (def.parameters && !Value.Check(def.parameters as any, args ?? {})) {
		const errors = [...Value.Errors(def.parameters as any, args ?? {})]
			.map((e) => `${e.path || "(root)"}: ${e.message}`)
			.join("; ");
		leanError(`[E_LEAN_ARGS] Invalid arguments for subagent: ${errors}`);
	}
	return def.execute(toolCallId, args ?? {}, signal, onUpdate, ctx);
}

// ---------------------------------------------------------------------------
// Lean tool definitions
// ---------------------------------------------------------------------------

function buildLeanSubagentDef(scopedCatalog?: string | null): AnyToolDefinition | null {
	const captured = latest.get("subagent");
	if (!captured) return null;
	const def: AnyToolDefinition = {
		name: "subagent",
		label: captured.label ?? "Subagent",
		description: leanSubagentDescription(),
		promptSnippet: LEAN_SUBAGENT_SNIPPET,
		promptGuidelines: leanSubagentGuidelines(captured.promptGuidelines, scopedCatalog),
		parameters: leanSubagentSchema(captured.parameters),
		prepareArguments: (args: unknown) =>
			canonicalizeSpawnArgs(args, thinkingEnumOf(captured.parameters)),
		execute: subagentExecute,
		renderCall: (args: any, theme: any, context: any) =>
			latest.get("subagent")?.renderCall?.(args, theme, context) ?? new Text("subagent", 0, 0),
		renderResult: (result: any, options: any, theme: any, context: any) =>
			latest.get("subagent")?.renderResult?.(result, options, theme, context) ??
			new Text(textOfResult(result), 0, 0),
	};
	if (captured.executionMode) def.executionMode = captured.executionMode;
	return def;
}

function buildLeanOpsDef(): AnyToolDefinition | null {
	const ops = availableOps();
	const nonHelp = ops.filter((op) => op !== "help");
	if (!nonHelp.length) return null;
	return {
		name: "subagent_ops",
		label: "Subagent ops",
		description: leanOpsDescription(ops),
		promptSnippet: leanOpsSnippet(ops),
		parameters: leanOpsSchema(ops) as any,
		prepareArguments: (args: unknown) => canonicalizeOpsArgs(args, availableOps()),
		execute: opsExecute,
		renderCall: opsRenderCall,
		renderResult: opsRenderResult,
	};
}

/**
 * Scoped-model catalog for the guidelines: pi resolves enabledModels /
 * --models into ctx.scopedModels (empty when no scoping is configured).
 * Returns null then, keeping upstream's catalog line verbatim.
 */
function scopedCatalogFrom(ctx: unknown): string | null {
	const scoped = (ctx as { scopedModels?: unknown } | null | undefined)?.scopedModels;
	if (!Array.isArray(scoped) || scoped.length === 0) return null;
	return buildScopedCatalog(scoped as Parameters<typeof buildScopedCatalog>[0]);
}

function registerLeanTools(pi: ExtensionAPI, scopedCatalog?: string | null): void {
	const spawn = buildLeanSubagentDef(scopedCatalog);
	if (spawn) pi.registerTool(spawn);
	const ops = buildLeanOpsDef();
	if (ops) pi.registerTool(ops);
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function leanExtension(pi: ExtensionAPI): void {
	realPi = pi;
	const upstreamPi = makeUpstreamPi(pi);

	// Upstream registers its tools (captured), commands, renderers, and
	// event handlers here.
	upstream(upstreamPi);

	// Lean pair with pre-session texts; refreshed at session_start.
	registerLeanTools(pi);

	// Registered after upstream's own session_start handler, so upstream has
	// already spliced the live model catalog into its guidelines array.
	// Re-registering replaces by name: the tool list itself never changes.
	pi.on("session_start", async (_event, ctx) => {
		registerLeanTools(pi, scopedCatalogFrom(ctx));
	});
}

/** Test hook: clear module-level state (fresh-process semantics). */
export function __resetLeanStateForTests(): void {
	latest.clear();
	realPi = null;
}

/**
 * Test hook: overlay a stub on a captured upstream definition (e.g. spy on
 * execute without spawning real panes), keeping the real schema and text.
 */
export function __stubCapturedDefForTests(
	name: string,
	overrides: Partial<AnyToolDefinition>,
): boolean {
	const real = latest.get(name);
	if (!real) return false;
	latest.set(name, { ...real, ...overrides });
	return true;
}

/** Test hook: the captured upstream definitions (read-only view). */
export function __capturedToolsForTests(): string[] {
	return [...latest.keys()];
}

export { availableOps };
