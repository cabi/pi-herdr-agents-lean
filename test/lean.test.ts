/**
 * Tests for pi-herdr-agents-lean. Runs the real upstream extension
 * (pi-herdr-agents@3.3.0) against the harness through the lean wrapper.
 *
 * Covers: registration surface, op forwarding (every op reaches upstream,
 * lean-only fields stripped, write_task_models args merged), help content,
 * fill-in canonicalization (and its refusal to guess), spawn fill-ins,
 * upstream-schema validation order, tool-list stability across
 * upstream-schema validation order, tool-list stability across
 * session_start, blocked setActiveTools, the scoped model catalog
 * (enabledModels), and the subagent-child scenario.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Harness, makeCtx } from "./harness.ts";
import lean, {
	__capturedToolsForTests,
	__resetLeanStateForTests,
	__stubCapturedDefForTests,
	makeUpstreamPi,
} from "../src/index.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const inventory = JSON.parse(readFileSync(join(root, "upstream-inventory.json"), "utf8"));
const upstreamByName = Object.fromEntries(inventory.tools.map((t: any) => [t.name, t]));
const PARENT_OPS = [
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
const UPSTREAM_TOOL_NAMES = inventory.tools.map((t: any) => t.name);

const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
	for (const [key, value] of Object.entries(vars)) {
		if (!(key in savedEnv)) savedEnv[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function bootParent(): Harness {
	__resetLeanStateForTests();
	setEnv({ PI_SUBAGENT_ID: undefined, PI_DENY_TOOLS: undefined });
	const harness = new Harness(join(root, "test"));
	lean(harness as any);
	return harness;
}

/** Stub an upstream tool's execute and record the arguments lean forwards. */
function stubForward(tool: string, calls: Array<{ tool: string; args: any }>) {
	const ok = __stubCapturedDefForTests(tool, {
		execute: async (_id: string, args: any) => {
			calls.push({ tool, args });
			return { content: [{ type: "text", text: `${tool} ok` }], details: {} };
		},
	});
	if (!ok) throw new Error(`[E_TEST] no captured upstream def: ${tool}`);
}

beforeAll(() => {
	// The lean module imports upstream at module load; make sure the parent
	// scenario is active for the initial import too.
	setEnv({ PI_SUBAGENT_ID: undefined, PI_DENY_TOOLS: undefined });
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

// ---------------------------------------------------------------------------
// Registration surface
// ---------------------------------------------------------------------------

describe("registration (parent session)", () => {
	const harness = bootParent();

	it("registers exactly the two lean tools, in a stable order", () => {
		expect([...harness.tools.keys()]).toEqual(["subagent", "subagent_ops"]);
	});

	it("registers no upstream tool directly", () => {
		// "subagent" stays as the lean standalone spawn tool under its own name
		for (const name of UPSTREAM_TOOL_NAMES.filter((n: string) => n !== "subagent")) {
			expect(harness.tools.has(name)).toBe(false);
		}
	});

	it("keeps upstream commands and renderers (pass-through surface)", () => {
		for (const command of ["subagent", "subagents-init", "worktree"]) {
			expect(harness.commands).toContain(command);
		}
		for (const renderer of ["subagent_ping", "subagent_result", "subagent_status"]) {
			expect(harness.renderers).toContain(renderer);
		}
	});

	it("exposes every captured upstream tool as an op plus help", () => {
		const description = harness.tools.get("subagent_ops").description;
		for (const op of PARENT_OPS.filter((op) => op !== "help")) {
			expect(description).toContain(`- ${op}: `);
		}
		expect(description).toContain("- help:");
	});

	it("captures all upstream definitions for forwarding", () => {
		expect(__capturedToolsForTests().sort()).toEqual([...UPSTREAM_TOOL_NAMES].sort());
	});

	it("leans the texts without dropping the schema contract", () => {
		const subagent = harness.tools.get("subagent");
		const ops = harness.tools.get("subagent_ops");
		const upstreamSubagent = upstreamByName.subagent;

		expect(subagent.description.length).toBeLessThan(upstreamSubagent.description.length);
		expect(ops.description.length).toBeLessThan(
			inventory.tools
				.filter((t: any) => t.name !== "subagent")
				.reduce((sum: number, t: any) => sum + t.description.length, 0),
		);

		// subagent schema: same required, same properties, thinking enum kept,
		// worktree accepts a bare branch string, no long descriptions.
		expect(subagent.parameters.required).toEqual(upstreamSubagent.parameters.required);
		for (const key of Object.keys(upstreamSubagent.parameters.properties)) {
			expect(subagent.parameters.properties).toHaveProperty(key);
		}
		const thinkingConsts = subagent.parameters.properties.thinking.anyOf
			.map((s: any) => s.const)
			.filter((c: any) => c !== undefined);
		for (const c of upstreamSubagent.parameters.properties.thinking.anyOf.map((s: any) => s.const)) {
			expect(thinkingConsts).toContain(c);
		}
		expect(
			subagent.parameters.properties.worktree.anyOf.some(
				(s: any) => s.type === "string" && s.minLength === 1,
			),
		).toBe(true);
		const withDescription = Object.entries(subagent.parameters.properties)
			.filter(([, p]: any) => p.description)
			.map(([k]) => k);
		for (const key of withDescription) {
			expect(
				["agent", "skills", "tools", "cwd", "fork", "persistent", "interactive"],
			).toContain(key);
		}

		// ops schema: op not required (execute gives the clearer error), flat
		// common fields, args for the rare op.
		expect(ops.parameters.required).toBeUndefined();
		expect(ops.parameters.properties.op.type).toBe("string");
		for (const key of ["about", "id", "name", "message", "sessionPath", "autoExit", "target", "preserve", "args"]) {
			expect(ops.parameters.properties).toHaveProperty(key);
		}
	});

	it("replaces by name on re-boot instead of growing the tool list", () => {
		const harness2 = bootParent();
		expect([...harness2.tools.keys()]).toEqual(["subagent", "subagent_ops"]);
	});
});

// ---------------------------------------------------------------------------
// Op forwarding: every op reaches upstream execute
// ---------------------------------------------------------------------------

describe("op forwarding", () => {
	const harness = bootParent();
	const calls: Array<{ tool: string; args: any }> = [];

	it("forwards the simple ops with lean-only fields stripped", async () => {
		const cases: Array<[string, string, any, any]> = [
			["list", "subagents_list", { op: "list" }, {}],
			["interrupt", "subagent_interrupt", { op: "interrupt", id: "sp1" }, { id: "sp1" }],
			["cancel", "subagent_cancel", { op: "cancel", id: "sp1" }, { id: "sp1" }],
			["send", "subagent_send", { op: "send", id: "sp1", message: "hi" }, { id: "sp1", message: "hi" }],
			["stop", "subagent_stop", { op: "stop", id: "sp1" }, { id: "sp1" }],
			["resume", "subagent_resume", { op: "resume", sessionPath: "/tmp/s.jsonl", name: "R", autoExit: false }, { sessionPath: "/tmp/s.jsonl", name: "R", autoExit: false }],
			["worktree_list", "worktree_list", { op: "worktree_list" }, {}],
			["worktree_remove", "worktree_remove", { op: "worktree_remove", target: "../wt", preserve: true }, { target: "../wt", preserve: true }],
		];
		for (const [op, tool, call, expected] of cases) {
			stubForward(tool, calls);
			const result = await harness.callTool("subagent_ops", call);
			expect(result.details.leanOp, op).toBe(op);
			expect(calls.at(-1)!.tool, op).toBe(tool);
			expect(calls.at(-1)!.args, op).toEqual(expected);
		}
	});

	it("parses write_task_models args (JSON string) and forwards them", async () => {
		stubForward("subagents_write_task_models", calls);
		const wtm = {
			tasks: { coding: ["zai/glm-5.3"] },
			tasksMeta: { generatedAt: "2026-02-06T00:00:00.000Z", method: "registry-only" },
		};
		await harness.callTool("subagent_ops", { op: "write_task_models", args: JSON.stringify(wtm) });
		expect(calls.at(-1)!.args).toEqual(wtm);

		// args as an object works too, direct fields win over parsed args
		await harness.callTool("subagent_ops", {
			op: "write_task_models",
			args: { ...wtm, tasksMeta: { generatedAt: "2026-01-01T00:00:00.000Z", method: "registry-only" } },
			tasksMeta: wtm.tasksMeta,
		});
		expect(calls.at(-1)!.args).toEqual(wtm);

		// invalid args fail before upstream with a clear message
		await expect(
			harness.callTool("subagent_ops", { op: "write_task_models", args: "{nope" }),
		).rejects.toThrow(/\[E_LEAN_ARGS\].*JSON object string/);
		await expect(
			harness.callTool("subagent_ops", { op: "write_task_models", args: "[1,2]" }),
		).rejects.toThrow(/\[E_LEAN_ARGS\].*JSON object/);
	});

	it("rejects args on ops that take flat parameters", async () => {
		await expect(
			harness.callTool("subagent_ops", { op: "list", args: "{}" }),
		).rejects.toThrow(/\[E_LEAN_ARGS\].*only used by op write_task_models/);
	});

	it("validates against the upstream schema before executing", async () => {
		stubForward("subagent_send", calls);
		await expect(harness.callTool("subagent_ops", { op: "send" })).rejects.toThrow(
			/\[E_LEAN_ARGS\].*send.*message.*op: help.*about: send/s,
		);
	});
});

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

describe("help", () => {
	const harness = bootParent();

	it("returns the full upstream description, parameters, snippet, and guidelines", async () => {
		const send = upstreamByName.subagent_send;
		const result = await harness.callTool("subagent_ops", { op: "help", about: "send" });
		const text = result.content[0].text;
		expect(text).toContain("## description");
		expect(text).toContain(send.description);
		expect(text).toContain("## parameters");
		expect(text).toContain(JSON.stringify(send.parameters, null, 2));
		if (send.promptSnippet) {
			expect(text).toContain("## promptSnippet");
			expect(text).toContain(send.promptSnippet);
		}
		if (send.promptGuidelines?.length) {
			expect(text).toContain("## promptGuidelines");
			expect(text).toContain(send.promptGuidelines[0]);
		}
		expect(result.details.leanHelp).toBe("send");
	});

	it("accepts the upstream tool name and op aliases for about", async () => {
		const result = await harness.callTool("subagent_ops", {
			op: "help",
			about: "subagent_cancel",
		});
		expect(result.content[0].text).toContain(upstreamByName.subagent_cancel.description);
	});

	it("lists the ops when about is omitted", async () => {
		const result = await harness.callTool("subagent_ops", { op: "help" });
		const text = result.content[0].text;
		expect(result.details.leanHelp).toBe("list");
		for (const op of PARENT_OPS) expect(text).toContain(op);
	});

	it("rejects an unknown about value", async () => {
		await expect(
			harness.callTool("subagent_ops", { op: "help", about: "bogus" }),
		).rejects.toThrow(/\[E_LEAN_HELP_ABOUT\]/);
	});
});

// ---------------------------------------------------------------------------
// Fill-ins: canonicalization and inference (and refusal to guess)
// ---------------------------------------------------------------------------

describe("op fill-ins", () => {
	const harness = bootParent();
	const calls: Array<{ tool: string; args: any }> = [];

	it("canonicalizes case, separators, and the tool-name prefix", async () => {
		stubForward("subagents_list", calls);
		await harness.callTool("subagent_ops", { op: "List" });
		expect(calls.at(-1)!.tool).toBe("subagents_list");

		stubForward("subagent_stop", calls);
		await harness.callTool("subagent_ops", { op: "subagent_stop", id: "sp1" });
		expect(calls.at(-1)!.tool).toBe("subagent_stop");

		stubForward("worktree_remove", calls);
		await harness.callTool("subagent_ops", { op: "Worktree Remove", target: "../wt" });
		expect(calls.at(-1)!.tool).toBe("worktree_remove");
	});

	it("infers the op when only one op matches the arguments", async () => {
		stubForward("subagent_resume", calls);
		await harness.callTool("subagent_ops", { sessionPath: "/tmp/s.jsonl" });
		expect(calls.at(-1)!.tool).toBe("subagent_resume");

		stubForward("worktree_remove", calls);
		await harness.callTool("subagent_ops", { target: "../wt" });
		expect(calls.at(-1)!.tool).toBe("worktree_remove");

		stubForward("subagent_send", calls);
		await harness.callTool("subagent_ops", { message: "hi" });
		expect(calls.at(-1)!.tool).toBe("subagent_send");

		stubForward("subagents_write_task_models", calls);
		await harness.callTool("subagent_ops", {
			args: { tasks: { coding: ["m"] }, tasksMeta: { generatedAt: "2026-02-06T00:00:00.000Z", method: "registry-only" } },
		});
		expect(calls.at(-1)!.tool).toBe("subagents_write_task_models");

		// about implies help
		const helpResult = await harness.callTool("subagent_ops", { about: "send" });
		expect(helpResult.details.leanHelp).toBe("send");
	});

	it("does not guess when the call is ambiguous", async () => {
		// id matches interrupt/cancel/send/stop
		await expect(harness.callTool("subagent_ops", { id: "sp1" })).rejects.toThrow(
			/\[E_LEAN_OP\].*op/,
		);
		// {} matches list and worktree_list in a parent session
		await expect(harness.callTool("subagent_ops", {})).rejects.toThrow(
			/\[E_LEAN_OP\].*op/,
		);
	});

	it("rejects unknown ops with the available list", async () => {
		await expect(harness.callTool("subagent_ops", { op: "bogus" })).rejects.toThrow(
			/\[E_LEAN_OP\].*bogus.*Available ops: help, list/s,
		);
	});
});

// ---------------------------------------------------------------------------
// subagent (spawn) forwarding and fill-ins
// ---------------------------------------------------------------------------

describe("subagent fill-ins", () => {
	const harness = bootParent();
	const calls: Array<{ tool: string; args: any }> = [];

	beforeAll(() => {
		stubForward("subagent", calls);
	});

	it("forwards calls unchanged when the arguments are already clean", async () => {
		await harness.callTool("subagent", { name: "worker", task: "do it" });
		expect(calls.at(-1)!.args).toEqual({ name: "worker", task: "do it" });
	});

	it("accepts a bare branch string for worktree", async () => {
		await harness.callTool("subagent", { name: "worker", task: "t", worktree: "feat/x" });
		expect(calls.at(-1)!.args.worktree).toEqual({ branch: "feat/x" });
	});

	it("drops null-ish worktree values instead of creating a branch named null", async () => {
		for (const wt of [null, "null", "none", "undefined", ""]) {
			await harness.callTool("subagent", { name: "worker", task: "t", worktree: wt });
			const forwarded = calls.at(-1)!.args;
			expect(forwarded).not.toHaveProperty("worktree");
		}
	});

	it("joins array skills/tools into the upstream comma-separated strings", async () => {
		await harness.callTool("subagent", {
			name: "worker",
			task: "t",
			skills: ["a", "b"],
			tools: ["read", "bash"],
		});
		expect(calls.at(-1)!.args.skills).toBe("a,b");
		expect(calls.at(-1)!.args.tools).toBe("read,bash");
	});

	it("lowercases a valid thinking level", async () => {
		await harness.callTool("subagent", { name: "worker", task: "t", thinking: "HIGH" });
		expect(calls.at(-1)!.args.thinking).toBe("high");
	});

	it("drops a redundant op field instead of forwarding it", async () => {
		await harness.callTool("subagent", { op: "spawn", name: "worker", task: "t" });
		expect(calls.at(-1)!.args).toEqual({ name: "worker", task: "t" });
	});

	it("redirects other op values to subagent_ops", async () => {
		await expect(
			harness.callTool("subagent", { op: "cancel", name: "worker", task: "t" }),
		).rejects.toThrow(/\[E_LEAN_OP\].*subagent_ops/);
	});

	it("enforces upstream required fields (carried by the lean schema)", async () => {
		await expect(harness.callTool("subagent", { name: "worker" })).rejects.toThrow(
			/missing required field: task/,
		);
	});
});

// ---------------------------------------------------------------------------
// Tool-list stability
// ---------------------------------------------------------------------------

describe("tool list stability", () => {
	it("never changes names across session_start and blocks setActiveTools", async () => {
		const harness = bootParent();
		const namesBefore = [...harness.tools.keys()];
		await harness.emit("session_start", {}, undefined);
		expect([...harness.tools.keys()]).toEqual(namesBefore);
		expect(harness.setActiveCalls).toBe(0);

		// second session_start (session switch) is equally inert
		await harness.emit("session_start", {}, undefined);
		expect([...harness.tools.keys()]).toEqual(namesBefore);
		expect(harness.setActiveCalls).toBe(0);
	});

	it("the proxy swallows setActiveTools and captures registerTool", () => {
		const harness = new Harness(join(root, "test"));
		const activeBefore = harness.getActiveTools();
		const proxy = makeUpstreamPi(harness as any);

		proxy.setActiveTools(["only-this"]);
		expect(harness.setActiveCalls).toBe(0);
		expect(harness.getActiveTools()).toEqual(activeBefore);

		proxy.registerTool({ name: "proxy-stub", description: "d", parameters: { type: "object" } } as any);
		expect(harness.tools.has("proxy-stub")).toBe(false);
		expect(__capturedToolsForTests()).toContain("proxy-stub");

		__resetLeanStateForTests();
	});
});

// ---------------------------------------------------------------------------
// Scoped model catalog (enabledModels / --models)
// ---------------------------------------------------------------------------

describe("scoped model catalog", () => {
	const scopedModel = (over: Record<string, unknown> = {}) => ({
		provider: "zai",
		id: "glm-5.3-flash",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 32_768,
		// minimal unsupported (null); xhigh/max unmapped → excluded
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high" },
		...over,
	});

	it("replaces the upstream catalog with the scoped list when ctx.scopedModels is set", async () => {
		const harness = bootParent();
		await harness.emit(
			"session_start",
			{},
			makeCtx(join(root, "test"), {
				scopedModels: [
					{ model: scopedModel() },
					{ model: scopedModel() }, // duplicate ref → listed once
					{ model: scopedModel({ id: "glm-5.3" }) },
					{
						model: scopedModel({
							provider: "opencode-zen",
							id: "deepseek-v4-flash",
							input: ["text", "image"],
							contextWindow: 1_000_000,
							maxTokens: 384_000,
						}),
					},
					{
						model: scopedModel({
							provider: "llama.cpp",
							id: "unsloth/gpt-oss-20b-GGUF:Q4_K_XL",
							reasoning: false,
							contextWindow: undefined,
							maxTokens: undefined,
						}),
					},
					{ model: { provider: "zai" } }, // no id → dropped
				],
			}),
		);

		const guidelines = harness.tools.get("subagent").promptGuidelines as string[];
		const joined = guidelines.join("\n");
		expect(joined).toContain(
			"Authenticated subagent models enabled in this session (use exact provider/model-id only):",
		);
		expect(joined).toContain(
			"- llama.cpp/unsloth/gpt-oss-20b-GGUF:Q4_K_XL — non-reasoning, text",
		);
		expect(joined).toContain(
			"- opencode-zen/deepseek-v4-flash — reasoning (off/low/medium/high), text+image, 1000k context, 384k max output",
		);
		expect(joined).toContain(
			"- zai/glm-5.3-flash — reasoning (off/low/medium/high), text, 128k context, 33k max output",
		);
		expect(joined.match(/- zai\/glm-5\.3-flash —/g)?.length).toBe(1);

		// sorted by provider/id
		const llama = joined.indexOf("- llama.cpp/");
		const deepseek = joined.indexOf("- opencode-zen/");
		const zai = joined.indexOf("- zai/");
		expect(llama).toBeGreaterThanOrEqual(0);
		expect(deepseek).toBeGreaterThan(llama);
		expect(zai).toBeGreaterThan(deepseek);

		// upstream's own catalog (empty registry → "none discovered") not carried
		expect(joined).not.toContain("none discovered");
		// and the tool list is still exactly the lean pair
		expect([...harness.tools.keys()]).toEqual(["subagent", "subagent_ops"]);
	});

	it("rebuilds upstream task-category shortlists from the scoped set", async () => {
		const harness = bootParent();
		__stubCapturedDefForTests("subagent", {
			promptGuidelines: [
				"Coordinate subagent work.",
				"Authenticated subagent models (use exact provider/model-id only):\n- opencode/gemini-3-flash — reasoning (off/low), text, 128k context, 64k max output\n- opencode/claude-haiku-4-5 — reasoning (off/low/medium/high), text+image, 200k context, 64k max output\nTask-category shortlists (use task:<category> only as the entire model value):\n- coding: zai/glm-5.3, opencode/gpt-5.6-luna\n- review: opencode/claude-haiku-5-5, zai/glm-5.3-flash\n- qa: opencode/gpt-6-luna\nFor ordinary review, prefer a different authenticated model family.",
			],
		});
		await harness.emit(
			"session_start",
			{},
			makeCtx(join(root, "test"), {
				scopedModels: [
					{ model: scopedModel({ id: "glm-5.3" }) },
					{ model: scopedModel() },
				],
			}),
		);

		const guidelines = harness.tools.get("subagent").promptGuidelines as string[];
		const joined = guidelines.join("\n");
		expect(joined).toContain("Task-category shortlists");
		expect(joined).toContain("- coding: zai/glm-5.3\n");
		expect(joined).toContain("- review: zai/glm-5.3-flash");
		// non-scoped candidates and emptied categories are gone
		expect(joined).not.toContain("opencode/gpt-5.6-luna");
		expect(joined).not.toContain("opencode/claude-haiku");
		expect(joined).not.toContain("- qa:");
		// the note points at shortlists that are actually visible
		expect(joined).toContain("Prefer the configured task-category shortlists");
	});

	it("drops the shortlists and their note when no configured candidate is scoped", async () => {
		const harness = bootParent();
		__stubCapturedDefForTests("subagent", {
			promptGuidelines: [
				"Authenticated subagent models (use exact provider/model-id only):\n- opencode/gemini-3-flash — reasoning (off/low), text\nTask-category shortlists (use task:<category> only as the entire model value):\n- coding: opencode/gpt-5.6-luna\n- review: opencode/claude-haiku-5-5",
			],
		});
		await harness.emit(
			"session_start",
			{},
			makeCtx(join(root, "test"), {
				scopedModels: [{ model: scopedModel() }],
			}),
		);

		const guidelines = harness.tools.get("subagent").promptGuidelines as string[];
		const joined = guidelines.join("\n");
		expect(joined).not.toContain("Task-category shortlists");
		expect(joined).not.toContain("Prefer the configured task-category shortlists");
		// the scoped catalog itself is still there
		expect(joined).toContain("- zai/glm-5.3-flash —");
	});

	it("keeps the upstream catalog verbatim when no scoping is configured", async () => {
		const harness = bootParent();
		// default ctx has scopedModels: [] — no scoping configured
		await harness.emit("session_start", {}, undefined);
		const guidelines = harness.tools.get("subagent").promptGuidelines as string[];
		const joined = guidelines.join("\n");
		expect(joined).toContain("Authenticated subagent models");
		expect(joined).toContain("none discovered");
		expect(joined).not.toContain("enabled in this session");
	});
});

// ---------------------------------------------------------------------------
// Subagent child session
// ---------------------------------------------------------------------------

describe("child session scenario", () => {
	let harness: Harness;

	beforeAll(() => {
		setEnv({ PI_SUBAGENT_ID: "test-child", PI_DENY_TOOLS: "subagent,subagent_interrupt" });
		__resetLeanStateForTests();
		harness = new Harness(join(root, "test"));
		lean(harness as any);
	});

	afterAll(() => {
		setEnv({ PI_SUBAGENT_ID: undefined, PI_DENY_TOOLS: undefined });
	});

	it("registers only subagent_ops with the reduced op set", () => {
		expect([...harness.tools.keys()]).toEqual(["subagent_ops"]);
		const description = harness.tools.get("subagent_ops").description;
		for (const op of ["help", "list", "cancel", "send", "stop", "resume"]) {
			expect(description).toContain(`${op}:`);
		}
		for (const op of ["interrupt", "worktree_list", "worktree_remove", "write_task_models"]) {
			expect(description).not.toContain(`${op}:`);
		}
	});

	it("still forwards ops and infers the sole zero-arg op", async () => {
		const calls: Array<{ tool: string; args: any }> = [];
		stubForward("subagents_list", calls);
		const result = await harness.callTool("subagent_ops", {});
		expect(result.details.leanOp).toBe("list");
		expect(calls.at(-1)!.args).toEqual({});

		stubForward("subagent_send", calls);
		await harness.callTool("subagent_ops", { op: "send", id: "parent", message: "done" });
		expect(calls.at(-1)!.args).toEqual({ id: "parent", message: "done" });
	});

	it("rejects parent-only ops with a clear message", async () => {
		await expect(
			harness.callTool("subagent_ops", { op: "worktree_list" }),
		).rejects.toThrow(/\[E_LEAN_OP\].*not available in this session/);
	});
});
