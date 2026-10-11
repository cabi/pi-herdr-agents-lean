/**
 * Reflection comparison: run the upstream entry and the lean entry against an
 * instrumented pi object in one process, then diff what they touch.
 *
 * Reports: registered tools (with def surface), commands, message renderers,
 * events, setActiveTools attempts, and all other pi property accesses —
 * i.e. every contract surface besides the texts themselves.
 */

import upstream from "pi-herdr-agents/pi-extension/subagents/index.ts";
import lean from "../src/index.ts";

type Sink = {
	tools: any[];
	setActiveCalls: any[];
	commands: any[];
	renderers: string[];
	events: string[];
	piEvents: string[];
	gets: string[];
};

function probePi(sink: Sink) {
	const base: any = {
		registerTool: (def: any) => sink.tools.push(def),
		setActiveTools: (ids: any) => sink.setActiveCalls.push(ids),
		registerCommand: (cmd: any) => sink.commands.push(cmd.name ?? cmd.id ?? "?"),
		registerMessageRenderer: (name: string) => sink.renderers.push(name),
		on: (ev: string) => sink.events.push(ev),
		events: { on: (ev: string) => sink.piEvents.push(ev) },
	};
	return new Proxy(base, {
		get(target, key) {
			const k = String(key);
			if (!sink.gets.includes(k)) sink.gets.push(k);
			const v = (target as any)[k];
			return typeof v === "function" ? v.bind(target) : v;
		},
		has() {
			return false; // force upstream to go through the get trap
		},
	});
}

function defSurface(t: any) {
	return {
		name: t.name,
		prepareArguments: typeof t.prepareArguments === "function",
		renderCall: typeof t.renderCall === "function",
		renderResult: typeof t.renderResult === "function",
		executionMode: "executionMode" in t ? t.executionMode : null,
		descChars: (t.description ?? "").length,
		props: t.parameters?.properties ? Object.keys(t.parameters.properties) : [],
		required: t.parameters?.required ?? [],
	};
}

function run(ext: any) {
	const sink: Sink = {
		tools: [],
		setActiveCalls: [],
		commands: [],
		renderers: [],
		events: [],
		piEvents: [],
		gets: [],
	};
	ext(probePi(sink));
	return { sink, defs: sink.tools.map(defSurface) };
}

const up = run(upstream);
const le = run(lean);

const report = {
	upstream: {
		tools: up.sink.tools.map((t) => t.name),
		commands: up.sink.commands,
		renderers: up.sink.renderers,
		events: [...new Set([...up.sink.events, ...up.sink.piEvents])],
		setActiveToolsCalls: up.sink.setActiveCalls.length,
		piPropsTouched: up.sink.gets,
		defs: up.defs,
	},
	lean: {
		tools: le.sink.tools.map((t) => t.name),
		commands: le.sink.commands,
		renderers: le.sink.renderers,
		events: [...new Set([...le.sink.events, ...le.sink.piEvents])],
		setActiveToolsCalls: le.sink.setActiveCalls.length,
		piPropsTouched: le.sink.gets,
		defs: le.defs,
	},
	diff: {
		onlyUpstreamCommands: up.sink.commands.filter((c) => !le.sink.commands.includes(c)),
		onlyLeanCommands: le.sink.commands.filter((c) => !up.sink.commands.includes(c)),
		onlyUpstreamRenderers: up.sink.renderers.filter((c) => !le.sink.renderers.includes(c)),
		onlyUpstreamEvents: [...new Set([...up.sink.events, ...up.sink.piEvents])].filter(
			(e) => ![...le.sink.events, ...le.sink.piEvents].includes(e),
		),
	},
};

console.log(JSON.stringify(report, null, 2));
