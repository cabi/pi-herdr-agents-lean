# Upstream issue draft: model catalog ignores enabledModels

Post this to <https://github.com/giuseppecrj/pi-herdr-agents/issues>.

---

## Title

Model catalog ignores `enabledModels`: offers provider-disabled models and hides enabled ones

## Problem

The `session_start` handler builds the model catalog from
`buildAuthenticatedModelCatalog(registry, 24, …)` (`pi-extension/subagents/index.ts`, the
`runtime.modelCatalog = …` line), which iterates `registry.getAvailable()`. That snapshot
contains **every model of every configured-auth provider** — `enabledModels` / `--models` are
never consulted, and the alphabetical list is truncated at 24 plus "… N more authenticated
models omitted".

Two failure modes, both observed live (pi 1.1.0, pi-herdr-agents 3.2.1, `enabledModels`
configured to a handful of `zai/*` models):

1. **Authenticated-but-disabled models appear in the catalog.** The model picked
   `opencode/gemini-3-flash` and `opencode/claude-haiku-4-5` straight from the catalog line;
   both children failed ~2s later with
   `403 … "Upstream request failed: Model access is disabled"`.
2. **Enabled models can be invisible.** All enabled `zai/*` models sat in the omitted tail
   (the session showed "… 482 more authenticated models omitted"), so the model could not have
   chosen them even after the 403s.

Pi already hands extensions the resolved set: `ctx.scopedModels`
("resolved from --models / enabledModels settings against the available catalogue … Empty
when no scoping is configured").

## Solution

When `ctx.scopedModels` is non-empty, build the catalog from that set instead of the
available snapshot (same per-model facts format, no truncation needed); keep the current
behavior when it is empty. Filtering the task-category shortlist candidates to scoped refs
completes it.

Sketch of the mechanism, from the wrapper where we shipped this
([pi-herdr-agents-lean](https://github.com/cabi/pi-herdr-agents-lean), commit `658597d`):

```diff
--- a/src/index.ts
+++ b/src/index.ts
@@ (session_start handler)
-	pi.on("session_start", async () => {
-		registerLeanTools(pi);
+	pi.on("session_start", async (_event, ctx) => {
+		// ctx.scopedModels = pi's resolution of enabledModels / --models
+		registerLeanTools(pi, scopedCatalogFrom(ctx));
```

```diff
--- a/src/lean-text.ts
+++ b/src/lean-text.ts
@@ (guidelines assembly)
-	if (catalog) rules.push(catalog);
+	if (scopedCatalog) rules.push(scopedCatalog);
+	else if (catalog) rules.push(catalog);

+export function buildScopedCatalog(
+	scoped?: readonly ScopedModelLike[] | null,
+ ): string | null {
+	if (!scoped?.length) return null;
+	return (
+		"Authenticated subagent models enabled in this session (use exact provider/model-id only):\n" +
+		scoped.map((e) => catalogLine(e.model)).join("\n")
+	);
+	// catalogLine: "provider/id — reasoning (low/high/max), text+image, 262k context, 131k max output"
+}
```

In upstream this lands where `runtime.modelCatalog` is assigned: use the scoped variant when
`ctx.scopedModels?.length > 0`, otherwise `buildAuthenticatedModelCatalog(registry, 24, …)`.

## Result

Same session, same prompt, before → after:

- before: children spawned on catalog entries `opencode/gemini-3-flash`,
  `opencode/claude-haiku-4-5` → both `403 Model access is disabled`, 9 tool calls to converge
- after: `zai/glm-5.3-flash` picked from the scoped line, 0 failures, 4 calls — and the
  per-model thinking levels in the line (`reasoning (low/high/max)`) also eliminated the
  thinking-level retry loop

Scoped catalog of 10 models costs ~650 tokens, replacing the 24-entry line plus tail note.
