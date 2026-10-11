/**
 * Capture every tool upstream registers, with the exact texts the model reads.
 *
 * Runs upstream's extension entry against a mock pi object. registerTool
 * calls are captured in full; everything else (events, commands, message
 * renderers) is recorded as a no-op so upstream init completes unchanged.
 *
 * Output: upstream-inventory.json — one entry per tool with description,
 * promptSnippet, promptGuidelines, parameters schema, character counts for
 * each, and the auxiliary def surface (renderCall/renderResult/…).
 *
 * Scenarios (via SCENARIO env): parent (default), child (PI_SUBAGENT_ID set,
 * i.e. the view a subagent session gets).
 */

import { writeFileSync } from "node:fs";
import upstream from "pi-herdr-agents/pi-extension/subagents/index.ts";

type Captured = Record<string, any>;

const scenario = process.env.SCENARIO ?? "parent";
if (scenario === "child") {
	process.env.PI_SUBAGENT_ID = "test-child";
	process.env.PI_SUBAGENT_AGENT = "worker";
	process.env.PI_DENY_TOOLS = "subagent,subagent_interrupt";
}

const tools: Captured[] = [];
const calls: { kind: string; name?: string; event?: string }[] = [];

function record(kind: string, name?: string, event?: string) {
	calls.push({ kind, name, event });
}

/**
 * Universal chainable mock: callable, and every property access yields
 * another chainable mock (so `pi.events.on(...)`, `pi.a.b.c` etc. all work).
 * Calls report through `onCall(kind, name?)`.
 */
function chainMock(
	_path: string,
	onCall: (kind: string, name?: string) => void,
): any {
	const fn = (...args: unknown[]) => {
		onCall(_path, typeof args[0] === "string" ? args[0] : undefined);
		return undefined;
	};
	return new Proxy(fn, {
		get(target, prop) {
			if (prop === Symbol.toPrimitive) return () => "";
			if (typeof prop === "symbol") return undefined;
			if (prop in target) return (target as any)[prop];
			return chainMock(`${_path}.${String(prop)}`, onCall);
		},
	});
}

const pi: any = new Proxy(
	{ __mock: true } as Record<string, unknown>,
	{
		get(target, prop) {
			if (prop === "registerTool") {
				return (def: any) => {
					tools.push(captureDef(def));
					record("tool", def.name);
				};
			}
			if (prop === "registerCommand") {
				return (name: string, _cmd: unknown) => record("command", name);
			}
			if (prop === "registerMessageRenderer") {
				return (name: string, _fn: unknown) => record("renderer", name);
			}
			if (prop === "on") {
				return (event: string, _fn: unknown) => record("event", undefined, event);
			}
			if (prop === "getActiveTools") return () => [] as string[];
			if (prop === "getThinkingLevel") return () => "medium";
			if (typeof prop === "symbol") return undefined;
			if (prop === "events") {
				target.events = chainMock("events", (kind, name) => record(kind, name));
			} else if (!(prop in target)) {
				// Generic chainable no-op for any other API member.
				target[prop] = chainMock(String(prop), () => {});
			}
			return target[prop];
		},
	},
);

/** Copy a tool def with functions replaced by presence markers. */
function captureDef(def: any): Captured {
	const out: Captured = {};
	for (const [key, value] of Object.entries(def)) {
		out[key] =
			typeof value === "function" ? { __fn: true } : structuredClone(value);
	}
	return out;
}
upstream(pi);

function chars(value: unknown): number {
	if (value == null) return 0;
	return typeof value === "string"
		? value.length
		: JSON.stringify(value)?.length ?? 0;
}

const inventory = {
	generatedAt: new Date().toISOString(),
	upstreamVersion: (await import("pi-herdr-agents/package.json", { with: { type: "json" } })).default
		.version,
	scenario,
	note: "promptGuidelines for `subagent` are captured at registration; upstream splices the same live array at session_start (adds the authenticated model catalog as the last line and swaps the model-choice bullets when task preferences exist).",
	registrationCalls: calls,
	tools: tools.map((def) => ({
		name: def.name,
		label: def.label,
		description: def.description ?? null,
		descriptionChars: chars(def.description),
		promptSnippet: def.promptSnippet ?? null,
		promptSnippetChars: chars(def.promptSnippet),
		promptGuidelines: def.promptGuidelines ?? null,
		promptGuidelinesChars: chars(def.promptGuidelines),
		parameters: def.parameters ?? null,
		parametersChars: chars(def.parameters),
		outputSchema: def.outputSchema ?? null,
		outputSchemaChars: chars(def.outputSchema),
		executionMode: def.executionMode ?? null,
		hasPrepareArguments: def.prepareArguments?.__fn === true,
		hasRenderCall: def.renderCall?.__fn === true,
		hasRenderResult: def.renderResult?.__fn === true,
		totalStaticChars:
			chars(def.description) +
			chars(def.promptSnippet) +
			chars(def.promptGuidelines) +
			chars(def.parameters),
	})),
};

writeFileSync(
	scenario === "child" ? "upstream-inventory-child.json" : "upstream-inventory.json",
	`${JSON.stringify(inventory, null, 2)}\n`,
);

const total = inventory.tools.reduce(
	(sum: number, t: any) => sum + t.totalStaticChars,
	0,
);
console.log(`scenario=${scenario}`);
for (const t of inventory.tools) {
	console.log(
		`${t.name.padEnd(30)} desc=${String(t.descriptionChars).padStart(5)}  snippet=${String(t.promptSnippetChars).padStart(5)}  guidelines=${String(t.promptGuidelinesChars).padStart(5)}  schema=${String(t.parametersChars).padStart(5)}  total=${t.totalStaticChars}`,
	);
}
console.log(`tools=${inventory.tools.length}  grandTotalStaticChars=${total}`);
