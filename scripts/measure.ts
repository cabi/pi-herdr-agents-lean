/**
 * Token measurement: upstream pi-herdr-agents vs pi-herdr-agents-lean.
 *
 * Measures what the model reads on every request when the tools are ACTIVE:
 *   1. tool declarations   -> JSON.stringify({ name, description, parameters })
 *                             (mirrors pi's toToolDeclaration; outputSchema is
 *                             never sent to the model)
 *   2. prompt snippets     -> one "- name: snippet" line per tool
 *   3. prompt guidelines   -> one "- rule" bullet per tool, deduplicated across
 *                             tools exactly like pi's buildRules()
 *
 * Uses the same Harness the tests use, so the numbers reflect the real
 * registered definitions, not hand-maintained copies. session_start is
 * emitted first so upstream's model-catalog splice is included.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodingForModel } from "js-tiktoken";
import upstream from "pi-herdr-agents/pi-extension/subagents/index.ts";
import lean from "../src/index.ts";
import { Harness, makeCtx } from "../test/harness.ts";

const enc = encodingForModel("gpt-4o");
const { dependencies } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

type AnyDef = {
	name: string;
	description: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: unknown;
};

function declarationOf(def: AnyDef) {
	return JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }) + "\n";
}

function measure(active: string[], defs: Map<string, AnyDef>) {
	const tools = active.map((name) => defs.get(name)).filter((d) => d !== undefined);
	let declarations = "";
	for (const def of tools) declarations += declarationOf(def);
	let snippets = "";
	for (const def of tools) if (def.promptSnippet) snippets += `- ${def.name}: ${def.promptSnippet}\n`;
	const seen = new Set<string>();
	let guidelines = "";
	for (const def of tools) {
		for (const rule of def.promptGuidelines ?? []) {
			const key = rule.trim();
			if (seen.has(key)) continue;
			seen.add(key);
			guidelines += `- ${rule}\n`;
		}
	}
	const total = declarations + snippets + guidelines;
	return {
		tools,
		declarationChars: declarations.length,
		declarationTokens: enc.encode(declarations).length,
		snippetChars: snippets.length,
		snippetTokens: enc.encode(snippets).length,
		guidelineCount: seen.size,
		guidelineChars: guidelines.length,
		guidelineTokens: enc.encode(guidelines).length,
		totalChars: total.length,
		totalTokens: enc.encode(total).length,
	};
}

async function boot(kind: "upstream" | "lean", ctx?: Record<string, unknown>) {
	const harness = new Harness(freshWork);
	if (kind === "upstream") upstream(harness as never);
	else lean(harness as never);
	await harness.emit("session_start", {}, ctx ?? makeCtx(freshWork));
	return measure(harness.getActiveTools(), harness.tools as unknown as Map<string, AnyDef>);
}

delete process.env.PI_SUBAGENT_ID;
delete process.env.PI_DENY_TOOLS;
const freshWork = mkdtempSync(join(tmpdir(), "lean-measure-work-"));

const up = await boot("upstream");
const ln = await boot("lean");

// Scoped variant: what a session with enabledModels configured sees. Offline
// the registry is empty (upstream's catalog collapses to "none discovered");
// these 10 synthetic models stand in for the user's enabled set.
const m = (
	provider: string,
	id: string,
	reasoning: boolean,
	input: string[],
	contextWindow: number,
	maxTokens: number,
) => ({
	model: {
		provider,
		id,
		reasoning,
		input,
		contextWindow,
		maxTokens,
		thinkingLevelMap: { minimal: null, low: "low", medium: "medium", high: "high" },
	},
});
const scopedCtx = makeCtx(freshWork, {
	scopedModels: [
		m("llama.cpp", "unsloth/gpt-oss-20b-GGUF:Q4_K_XL", false, ["text"], 33_000, 33_000),
		m("llama.cpp", "unsloth/qwen3-30b-a3b-GGUF:Q4_K_XL", true, ["text"], 33_000, 33_000),
		m("opencode-zen", "deepseek-v4-flash", true, ["text"], 1_000_000, 384_000),
		m("opencode-zen", "deepseek-v4-pro", true, ["text"], 1_000_000, 384_000),
		m("opencode-zen", "kimi-k3", true, ["text", "image"], 1_000_000, 131_000),
		m("opencode-zen", "minimax-m3", true, ["text", "image"], 512_000, 128_000),
		m("zai", "glm-5.3", true, ["text", "image"], 262_000, 131_000),
		m("zai", "glm-5.3-flash", true, ["text", "image"], 262_000, 131_000),
		m("zai", "glm-5.2", true, ["text"], 200_000, 64_000),
		m("zai", "glm-5-turbo", true, ["text"], 200_000, 64_000),
	],
});
const lnScoped = await boot("lean", scopedCtx);

const width = [26, 56, 56];
const line = (row: string[]) => {
	console.log(row.map((cell, i) => String(cell).padEnd(width[i])).join("|"));
};

console.log(`upstream pi-herdr-agents@${dependencies["pi-herdr-agents"]} vs lean (parent session, js-tiktoken o200k_base)\n`);

line(["per-tool declarations", "upstream tokens", "lean tokens"]);
for (const def of up.tools) line([`  ${def.name}`, String(enc.encode(declarationOf(def)).length), ""]);
for (const def of ln.tools) line([`  ${def.name}`, "", String(enc.encode(declarationOf(def)).length)]);
console.log();

const rows: string[][] = [
	["active tools", up.tools.length + " tools", ln.tools.length + " tools (" + ln.tools.map((t) => t.name).join(", ") + ")"],
	["declarations (chars)", String(up.declarationChars), String(ln.declarationChars)],
	["declarations (tokens)", String(up.declarationTokens), String(ln.declarationTokens)],
	["snippets (chars)", String(up.snippetChars), String(ln.snippetChars)],
	["snippets (tokens)", String(up.snippetTokens), String(ln.snippetTokens)],
	["guidelines", `${up.guidelineCount} rules / ${up.guidelineTokens} tokens`, `${ln.guidelineCount} rules / ${ln.guidelineTokens} tokens`],
	["TOTAL (chars)", String(up.totalChars), String(ln.totalChars)],
	["TOTAL (tokens)", String(up.totalTokens), String(ln.totalTokens)],
];
const saved = up.totalTokens - ln.totalTokens;
rows.push(["saved per request", "", `${saved} tokens (${((saved / up.totalTokens) * 100).toFixed(1)}%)`]);
for (const row of rows) {
	line(row);
	if (row[0].startsWith("TOTAL")) console.log("-".repeat(width.reduce((a, b) => a + b + 2, 0)));
}

console.log(`\nlean with model scoping (ctx.scopedModels = 10 enabled models):`);
line([
	"  guidelines",
	`${lnScoped.guidelineCount} rules / ${lnScoped.guidelineTokens} tokens`,
	`(unscoped lean: ${ln.guidelineCount} rules / ${ln.guidelineTokens} tokens; offline baseline carries a "none discovered" catalog — in real sessions the scoped list replaces upstream's full catalog line instead)`,
]);

rmSync(freshWork, { recursive: true, force: true });
