# Proof-point: ADK A2UI via Google's Python Agent SDK + CopilotKit A2UI Middleware

**Branch:** `mark/google-a2ui-adk-proof-point` (worktree off the OSS-158 branch, so the
Google-SDK demos sit side-by-side with the toolkit-based `a2ui_dynamic_schema` /
`a2ui_recovery` demos for comparison).

**Goal.** Re-build the ADK A2UI integration so that generation + validation are driven
by **Google's `a2ui-agent-sdk`** instead of our `ag-ui-a2ui-toolkit`, while still
painting through the **CopilotKit A2UI middleware** over AG-UI (no A2A). This exercises
whether the two halves compose, and isolates what our toolkit contributes that Google's
SDK does not.

**Status:** core build complete and locally verified; remaining work is mechanical dojo
wiring (see [What remains](#what-remains)). This document is the findings write-up.

---

## Architecture (as built)

```
ADK LlmAgent (gemini-2.5-pro)
  instruction = role/workflow prose
  tools = [ GoogleA2uiSendTool ]              ← re-hosts Google SDK brains (see Finding 2)
        │  model calls send_a2ui_json_to_client({a2ui_json})
        │  tool: parse_and_fix + A2uiValidator.validate  → {"validated_a2ui_json": [...]}
        │  (the tool ALSO injects catalog schema + examples into the system prompt)
        ▼
ag_ui_adk (ADKAgent)  →  ADK FunctionCall/Response → AG-UI TOOL_CALL_* / TOOL_CALL_RESULT
        ▼   (served via add_adk_fastapi_endpoint at /adk-google-a2ui-{dynamic-schema,recovery})
[TS] ADKAgent (HttpAgent)
   .use(
      new A2UIMiddleware({ injectA2UITool:false, a2uiToolNames:["send_a2ui_json_to_client"],
                           defaultCatalogId:"…/dynamic_catalog.json" }),   ← UNMODIFIED package
      new GoogleA2uiShim(),   ← innermost (disposable): {validated_a2ui_json:[…]} → {a2ui_operations:[…]}
   )
        ▼  client renderer paints the surface (dojo dynamic catalog: Row/HotelCard/…)
```

`injectA2UITool:false` + no `schema` → Google's tool is the sole prompt/catalog injector
(avoids double injection). The shim is innermost because the client chains middleware
with `reduceRight` (last `.use()` arg = closest to the agent).

---

## Findings

### 1. It IS wireable without A2A.
Google's `send_a2ui_json_to_client` is a **model-called** tool; its validated JSON is
transport-neutral. The only A2A coupling is in Google's separate `A2uiPartConverter`
(wraps the result in an A2A `DataPart`), which we don't use. The tool call + response
surface through `ag_ui_adk`'s normal ADK→AG-UI translation as `TOOL_CALL_*` /
`TOOL_CALL_RESULT`, which the CopilotKit A2UI middleware gates/paints.

### 2. Google's `SendA2uiToClientToolset` is unusable as published — re-hosted its brains.
`a2ui-agent-sdk==0.2.4` cannot be used directly in this (non-A2A) context:
- **Import-time A2A coupling.** Importing the toolset module pulls in
  `a2ui.adk.a2a.part_converter` → `from a2a.types import DataPart`. That requires the
  A2A SDK even though we never use A2A, and it is **incompatible with `a2a-sdk` 1.x**
  (1.x restructured `a2a.types`; `DataPart` is no longer top-level). Worked around by
  pinning `a2a-sdk>=0.3.0,<1.0.0` in the examples env.
- **Broken under current google-adk.** The toolset annotates a method
  `llm_request: models.LlmRequest` without importing `models` (and without
  `from __future__ import annotations`), so the class raises `NameError` at import.

→ We re-host the SDK's **reusable, A2A-free brains** — `A2uiSchemaManager` (catalog +
`render_as_llm_instructions`), `A2uiCatalog.validator` (`A2uiValidator`), and
`parse_and_fix` (healing) — in a thin ADK `BaseTool` (`GoogleA2uiSendTool` in
`server/api/_google_a2ui_common.py`) that mirrors the toolset's `run_async`
byte-for-byte (same tool name, same `{"validated_a2ui_json"|"error"}` return keys, same
prompt injection). This is a faithful "Google SDK" build, and the toolset's
brokenness/A2A-coupling is itself a finding (it reinforces that the published agent SDK
is A2A-oriented).

### 3. The wire shapes already match — the shim is near-identity.
Google's `validated_a2ui_json` is an array of v0.9 messages, each shaped
`{"version":"v0.9","createSurface|updateComponents|updateDataModel":{…}}` — i.e. exactly
our `a2ui_operations` op objects. The shim only rewrites the TOOL_CALL_RESULT envelope
key (`validated_a2ui_json` → `a2ui_operations`); no per-op translation needed.

### 4. Recovery is the real differentiator (demonstrated, not patched).
- **Google's SDK has no bounded retry loop.** `send_a2ui_json_to_client` validates once;
  on failure it returns `{"error": "..."}` to the model. Any retry is **model-driven**
  (the LLM may choose to re-call the tool) and **unbounded** — no attempt cap, no
  structured error-augmented re-prompt, no hard-failure envelope/UX.
- **The CopilotKit middleware only paint-gates** — it suppresses an invalid surface and
  shows a "retrying" status, but never drives regeneration.
- **Our toolkit** is what provides the bounded `run_a2ui_generation_with_recovery` loop
  (attempt cap, errors fed back into the prompt) and the `a2ui_recovery_exhausted`
  hard-failure envelope.
  → So a Google-SDK build through this middleware gets validate + paint-gate, but the
  *structured recovery loop is absent*. This proof-point demonstrates that gap rather
  than papering over it.

### 5. Validator behavior verified locally (no browser needed).
Against Google's real `A2uiValidator` (dojo dynamic catalog, `remove_strict_validation`):
- valid HotelCard surface → **passes**;
- dangling child-ref surface (Row references a missing `card` template) →
  **fails**: `Component 'root' references non-existent component 'card' in field
  'children.componentId'`. (This is the integrity check, keyed off the `children`
  property name — so a minimal/permissive component catalog suffices.)
- Each message **must** carry `"version":"v0.9"` or validation fails up front.

### 6. Dependency pins (examples env only — proof-point isolation).
`a2ui-agent-sdk>=0.2.4`, `a2a-sdk>=0.3.0,<1.0.0`, `google-adk>=1.28.1` (compatible with
`ag_ui_adk`'s `<3.0.0`). The `ag_ui_adk` package itself is **unchanged**.

---

## Comparison matrix

| Layer | Google-SDK build (this proof-point) | Our-toolkit build (OSS-158) |
|---|---|---|
| Prompt / catalog injection | `A2uiSchemaManager.render_as_llm_instructions` (in the tool) | `build_subagent_prompt` + middleware schema-context |
| Generation tool | `send_a2ui_json_to_client` (a2ui_json string) | `render_a2ui` sub-agent (typed/atomic) |
| Validation | `A2uiValidator` (graph/depth/JSON-Pointer) | `validate_a2ui_components` (+ binding resolution) |
| Healing | `parse_and_fix` (cuttable-keys) | none (extract-only) |
| Recovery | **model-driven, unbounded** | **bounded loop + exhaustion UX** |
| Paint-gate | CopilotKit A2UI middleware | same |
| Transport | AG-UI via `ag_ui_adk` (no A2A) | same |

---

## What's built (this branch)
- `examples/server/api/_google_a2ui_common.py` — dynamic catalog + `GoogleA2uiSendTool`
  (Google SDK brains) + role prose + in-context example.
- `examples/server/api/google_a2ui_dynamic_schema.py`, `google_a2ui_recovery.py` — ADK
  agents; registered in `api/__init__.py` + mounted in `server/__init__.py` at
  `/adk-google-a2ui-dynamic-schema` and `/adk-google-a2ui-recovery`.
- `examples/pyproject.toml` — `a2ui-agent-sdk` + `a2a-sdk<1.0` + `google-adk>=1.28.1`.
- `apps/dojo/src/google-a2ui-shim.ts` — disposable result-normalizing middleware.
- `apps/dojo/src/agents.ts` — `google_a2ui_dynamic_schema` / `google_a2ui_recovery`
  wired with `.use(A2UIMiddleware({injectA2UITool:false, a2uiToolNames:[…]}), shim)`
  (kept OUT of the route's `a2ui.agents` auto-attach list).
- Dojo routes: `config.ts` + `menu.ts` (under `adk-middleware`) +
  `types/integration.ts` (`Feature` union) entries, and the two feature pages
  `app/[integrationId]/feature/(v2)/google_a2ui_{dynamic_schema,recovery}/page.tsx`
  (+ `style.css`) — same dojo dynamic catalog + suggestions as the toolkit demos.

Verified in-sandbox: example server imports (89 routes); Google validator pass/fail
behavior; dojo import symbols resolve. (Full dojo build/typecheck + browser e2e run
outside the sandbox.)

## What remains
Optional (deferred; run/verify outside the sandbox):
- `apps/dojo/e2e/google-a2ui-adk-fixtures.ts` — aimock fixtures: Gemini calling
  `send_a2ui_json_to_client` with `{a2ui_json:"…"}`; dynamic_schema → valid; recovery →
  first call invalid (tool `{error}`) then valid (model-driven retry); exhaust → always
  invalid (no surface; note: no hard-failure UI, unlike the toolkit build).
- `apps/dojo/e2e/tests/adkMiddlewareTests/googleA2ui{DynamicSchema,Recovery}.spec.ts`.

## How to run (outside the sandbox)
1. `pnpm install` at the repo root, then `pnpm build`.
2. `cd integrations/adk-middleware/python/examples && uv sync` (installs `a2ui-agent-sdk`
   + pinned `a2a-sdk<1.0`). Live runs need `GOOGLE_API_KEY`.
3. From `apps/dojo`: `npm run run-everything` (starts dojo + ADK uvicorn + aimock;
   routes ADK Gemini to the mock).
4. Visit `/adk-middleware/feature/google_a2ui_dynamic_schema` and `…/google_a2ui_recovery`
   (after the remaining dojo wiring is added).
