/**
 * Minimal fake `ExtensionAPI` for driving the lean extension (and, through
 * its proxy, upstream pi-herdr-agents) in tests. Mirrors the pi behaviors
 * the extension relies on: registerTool replaces by name and adds
 * default-active tools to the active list, event handlers run sequentially
 * in registration order, setActiveTools replaces the active list,
 * pi.events subscriptions are recorded.
 *
 * `callTool` reproduces pi's prepare -> validate -> execute pipeline with a
 * small local schema validator (pi's own validator is not exported).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface CtxOverrides {
  model?: { id?: string; provider?: string; api?: string; input?: string[] } | undefined;
  [key: string]: unknown;
}

export function makeCtx(cwd: string, overrides: CtxOverrides = {}): any {
  return {
    ui: { notify() {} },
    mode: "json",
    hasUI: false,
    cwd,
    sessionManager: {
      getSessionFile: () => `${cwd}/session.jsonl`,
      getSessionDir: () => `${cwd}`,
      getSessionId: () => "test-session",
      getBranch: () => [],
    },
    modelRegistry: {
      find: () => undefined,
      getAvailable: () => [],
      getAll: () => [],
      hasConfiguredAuth: () => false,
    },
    model: { id: "test-model", provider: "test", input: ["text", "image"] },
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    abort() {},
    hasPendingMessages: () => false,
    tools: [],
    executeTool: async () => ({ content: [{ type: "text", text: "" }] }),
    ...overrides,
  };
}

type Handler = (event: any, ctx: any) => unknown;

export class Harness {
  tools = new Map<string, any>();
  active: string[];
  setActiveCalls = 0;
  commands: string[] = [];
  renderers: string[] = [];
  events = { on: () => {} };
  cwd: string;
  #handlers = new Map<string, Handler[]>();

  constructor(cwd: string, initialActive?: string[]) {
    this.cwd = cwd;
    this.active = initialActive ?? ["bash", "edit", "read", "write", "grep", "find", "ls"];
  }

  registerTool(def: any) {
    this.tools.set(def.name, def);
    if (def.defaultActive !== false && !this.active.includes(def.name)) {
      this.active.push(def.name);
    }
  }

  registerCommand(name: string) {
    this.commands.push(name);
  }

  registerMessageRenderer(name: string) {
    this.renderers.push(name);
  }

  on(event: string, handler: Handler) {
    const list = this.#handlers.get(event) ?? [];
    list.push(handler);
    this.#handlers.set(event, list);
    return () => {
      const l = this.#handlers.get(event);
      const i = l?.indexOf(handler) ?? -1;
      if (i >= 0) l!.splice(i, 1);
    };
  }

  getActiveTools(): string[] {
    return [...this.active];
  }

  setActiveTools(names: string[]) {
    this.active = [...names];
    this.setActiveCalls++;
  }

  /** Emit an extension event; handlers run sequentially in registration order. */
  async emit(event: string, eventObj: Record<string, unknown> = {}, ctx?: any) {
    for (const handler of [...(this.#handlers.get(event) ?? [])]) {
      await handler({ type: event, ...eventObj }, ctx ?? makeCtx(this.cwd));
    }
  }

  /** pi's prepare -> validate -> execute pipeline. Throws on validation errors. */
  async callTool(name: string, args: any, ctx?: any): Promise<any> {
    const def = this.tools.get(name);
    if (!def) throw new Error(`[E_TEST] no tool registered: ${name}`);
    const prepared = def.prepareArguments ? def.prepareArguments(args) : args;
    validate(prepared, def.parameters, name);
    return def.execute("test-call", prepared, undefined, undefined, ctx ?? makeCtx(this.cwd));
  }
}

// --- local JSON-schema validator (subset used by these tool schemas) -------

class ValidationError extends Error {}

function checkValue(field: string, value: unknown, prop: any) {
  if (value === undefined) return;
  if (prop.enum && !prop.enum.includes(value)) {
    throw new ValidationError(
      `[E_VALIDATION] ${field}: expected one of ${prop.enum.join(", ")}, got ${JSON.stringify(value)}`,
    );
  }
  if (prop.anyOf) {
    const ok = prop.anyOf.some((sub: any) => {
      try {
        checkValue(field, value, sub);
        return true;
      } catch {
        return false;
      }
    });
    if (!ok) {
      throw new ValidationError(
        `[E_VALIDATION] ${field}: value ${JSON.stringify(value)} matches none of the allowed types`,
      );
    }
    return;
  }
  if (prop.minLength !== undefined && typeof value === "string" && value.length < prop.minLength) {
    throw new ValidationError(
      `[E_VALIDATION] ${field}: shorter than minLength ${prop.minLength}`,
    );
  }
  const t = prop.type;
  if (t === "string" && typeof value !== "string") throw typeError(field, "string", value);
  if (t === "boolean" && typeof value !== "boolean") throw typeError(field, "boolean", value);
  if (t === "integer" && !Number.isInteger(value)) throw typeError(field, "integer", value);
  if (t === "number" && typeof value !== "number") throw typeError(field, "number", value);
  if (typeof value === "number" && prop.minimum !== undefined && value < prop.minimum) {
    throw new ValidationError(
      `[E_VALIDATION] ${field}: ${value} is below the minimum ${prop.minimum}`,
    );
  }
}

function typeError(field: string, expected: string, value: unknown) {
  return new ValidationError(
    `[E_VALIDATION] ${field}: expected ${expected}, got ${JSON.stringify(value)}`,
  );
}

export function validate(args: any, schema: any, tool: string) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new ValidationError(`[E_VALIDATION] ${tool}: arguments must be an object`);
  }
  for (const req of schema?.required ?? []) {
    if (!(req in args)) {
      throw new ValidationError(`[E_VALIDATION] ${tool}: missing required field: ${req}`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema?.properties?.[key];
    if (!prop) {
      if (schema?.additionalProperties === false) {
        throw new ValidationError(`[E_VALIDATION] ${tool}: unknown field: ${key}`);
      }
      continue;
    }
    checkValue(`${tool}.${key}`, value, prop);
  }
}

export { ValidationError };
