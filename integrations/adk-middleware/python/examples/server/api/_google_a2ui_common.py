"""Shared helpers for the Google-A2UI-Agent-SDK proof-point demos.

Proof-point (parallel to the toolkit-based ``a2ui_*`` demos): drive A2UI
generation/validation with **Google's** ``a2ui-agent-sdk`` (``A2uiSchemaManager`` +
``A2uiValidator`` + ``parse_and_fix`` + ``render_as_llm_instructions``) instead of our
``ag-ui-a2ui-toolkit``, while still painting through the CopilotKit A2UI middleware
over AG-UI. See ``docs/google-a2ui-proof-point.md``.

Why we wrap a thin tool instead of using Google's ``SendA2uiToClientToolset`` directly
(both are FINDINGS of this proof-point):
  1. **Import-time A2A coupling** — importing the toolset module pulls in
     ``a2ui.adk.a2a.part_converter`` → ``a2a.types.DataPart``, so it requires the A2A
     SDK even though we never use A2A transport (and it's pinned to a2a-sdk <1.0).
  2. **Broken under current google-adk** — ``a2ui-agent-sdk==0.2.4`` annotates a method
     ``llm_request: models.LlmRequest`` without importing ``models`` (and no
     ``from __future__ import annotations``), so the class fails to import.

So we re-host the SDK's *reusable, A2A-free brains* — ``A2uiSchemaManager`` (catalog +
``render_as_llm_instructions``), ``A2uiCatalog.validator`` (``A2uiValidator``), and
``parse_and_fix`` (healing) — in a minimal ADK ``BaseTool`` that mirrors the toolset's
``run_async`` byte-for-byte: tool name ``send_a2ui_json_to_client``, success returns
``{"validated_a2ui_json": [<messages>]}``, failure ``{"error": "..."}``. That
FunctionResponse surfaces through ``ag_ui_adk`` as an AG-UI TOOL_CALL_RESULT, which a
thin dojo-local shim normalizes into the ``{"a2ui_operations": [...]}`` envelope the
unmodified CopilotKit A2UI middleware paints.

NOTE: recovery here is **model-driven** (on ``{"error"}`` the model may re-call the
tool) — Google's SDK has no bounded validate->retry loop, unlike our toolkit. This is
intentional for the proof-point comparison.
"""

from __future__ import annotations

from typing import Any, Dict

from google.adk.tools import BaseTool, ToolContext
from google.genai import types as genai_types

from a2ui.parser.payload_fixer import parse_and_fix
from a2ui.schema.catalog import CatalogConfig
from a2ui.schema.catalog_provider import A2uiCatalogProvider
from a2ui.schema.common_modifiers import remove_strict_validation
from a2ui.schema.constants import (
    A2UI_TOOL_ERROR_KEY,
    A2UI_TOOL_NAME,
    A2UI_VALIDATED_JSON_KEY,
    VERSION_0_9,
)
from a2ui.schema.manager import A2uiSchemaManager

# Catalog id the dojo's dynamic renderer registers (Row + HotelCard + ProductCard +
# TeamMemberCard). Matches apps/dojo/src/a2ui-catalog/index.ts ``dynamicSchemaCatalog``.
DYNAMIC_CATALOG_ID = "https://a2ui.org/demos/dojo/dynamic_catalog.json"

# A minimal, permissive v0.9 catalog for Google's A2uiValidator. Component property
# schemas are intentionally loose (data-binding values arrive as {"path": ...} or
# literals); the validator's *integrity* checks (unique ids, root exists, dangling
# child refs) — keyed off the ``children``/``child`` property names — do the heavy
# lifting that powers the recovery demo's invalid (dangling-ref) case.
_DYN_VALUE: Dict[str, Any] = {}  # accept literal | {"path": ...} | {"event": ...}
DYNAMIC_CATALOG_SCHEMA: Dict[str, Any] = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "catalogId": DYNAMIC_CATALOG_ID,
    "components": {
        "Row": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "Row"},
                # ``children`` is recognized by the validator (by name) as a
                # component-reference field -> dangling refs are caught.
                "children": {},
                "gap": {"type": "number"},
            },
            "required": ["id", "component", "children"],
        },
        "HotelCard": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "HotelCard"},
                "name": _DYN_VALUE,
                "location": _DYN_VALUE,
                "rating": _DYN_VALUE,
                "pricePerNight": _DYN_VALUE,
                "amenities": _DYN_VALUE,
                "action": _DYN_VALUE,
            },
            "required": ["id", "component", "name"],
        },
        "ProductCard": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "ProductCard"},
                "name": _DYN_VALUE,
                "price": _DYN_VALUE,
                "rating": _DYN_VALUE,
                "description": _DYN_VALUE,
                "badge": _DYN_VALUE,
                "action": _DYN_VALUE,
            },
            "required": ["id", "component", "name"],
        },
        "TeamMemberCard": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "component": {"const": "TeamMemberCard"},
                "name": _DYN_VALUE,
                "role": _DYN_VALUE,
                "department": _DYN_VALUE,
                "email": _DYN_VALUE,
                "avatarUrl": _DYN_VALUE,
                "action": _DYN_VALUE,
            },
            "required": ["id", "component", "name"],
        },
    },
}


class _InMemoryCatalogProvider(A2uiCatalogProvider):
    """Serves an in-memory catalog dict (the dojo's dynamic catalog)."""

    def __init__(self, schema: Dict[str, Any]):
        self._schema = schema

    def load(self) -> Dict[str, Any]:
        return self._schema


def build_schema_manager() -> A2uiSchemaManager:
    """A2uiSchemaManager over v0.9 + the dojo dynamic catalog (strict validation relaxed)."""
    return A2uiSchemaManager(
        version=VERSION_0_9,
        catalogs=[
            CatalogConfig(
                name="dojo-dynamic",
                provider=_InMemoryCatalogProvider(DYNAMIC_CATALOG_SCHEMA),
            )
        ],
        schema_modifiers=[remove_strict_validation],
    )


class GoogleA2uiSendTool(BaseTool):
    """A thin ADK tool that re-hosts Google's a2ui-agent-sdk brains.

    Mirrors ``a2ui.adk.SendA2uiToClientToolset._SendA2uiJsonToClientTool`` exactly —
    same tool name, same prompt injection (catalog schema + examples), same validate/
    heal logic, same return keys — but without the toolset's import-time A2A coupling
    or its broken ``models.LlmRequest`` annotation (see module docstring).
    """

    def __init__(self, catalog, examples: str):
        super().__init__(
            name=A2UI_TOOL_NAME,  # "send_a2ui_json_to_client"
            description=(
                "Sends A2UI JSON to the client to render rich UI for the user. The A2UI"
                " JSON Schema is provided between the schema markers in the system"
                " instructions."
            ),
        )
        self._catalog = catalog
        self._examples = examples

    def _get_declaration(self) -> genai_types.FunctionDeclaration:
        return genai_types.FunctionDeclaration(
            name=self.name,
            description=self.description,
            parameters=genai_types.Schema(
                type=genai_types.Type.OBJECT,
                properties={
                    "a2ui_json": genai_types.Schema(
                        type=genai_types.Type.STRING,
                        description="valid A2UI JSON Schema to send to the client.",
                    ),
                },
                required=["a2ui_json"],
            ),
        )

    async def process_llm_request(self, *, tool_context: ToolContext, llm_request) -> None:
        # Inject the catalog schema + few-shot examples into the system instruction —
        # exactly what SendA2uiToClientToolset does (render_as_llm_instructions()).
        await super().process_llm_request(tool_context=tool_context, llm_request=llm_request)
        llm_request.append_instructions(
            [self._catalog.render_as_llm_instructions(), self._examples]
        )

    async def run_async(self, *, args: Dict[str, Any], tool_context: ToolContext) -> Any:
        a2ui_json = args.get("a2ui_json")
        if not a2ui_json:
            return {A2UI_TOOL_ERROR_KEY: f"Missing required arg a2ui_json for {self.name}"}
        try:
            payload = parse_and_fix(a2ui_json)  # Google's healing (cuttable-keys etc.)
            self._catalog.validator.validate(payload)  # Google's A2uiValidator
            # No second inference to summarize the JSON.
            tool_context.actions.skip_summarization = True
            return {A2UI_VALIDATED_JSON_KEY: payload}  # {"validated_a2ui_json": [...]}
        except Exception as e:  # noqa: BLE001 — surface as model-visible error
            return {A2UI_TOOL_ERROR_KEY: f"Failed to validate A2UI: {e}"}


def build_a2ui_tool() -> GoogleA2uiSendTool:
    """The model-called A2UI tool bound to the dojo dynamic catalog (Google SDK brains)."""
    catalog = build_schema_manager().get_selected_catalog()
    return GoogleA2uiSendTool(catalog=catalog, examples=A2UI_EXAMPLES)


# Role/workflow prose for the LlmAgent instruction. The tool appends the full catalog
# schema + examples; this just frames the task + the dojo's components.
ROLE_DESCRIPTION = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product/team comparisons, lists, cards),
generate an A2UI surface and send it with the send_a2ui_json_to_client tool.

You have 4 components in the catalog: Row (layout; use structural children to repeat a
card template per data item), HotelCard, ProductCard, TeamMemberCard. Root is ALWAYS a
Row whose children repeat a card template: {"componentId":"<card-id>","path":"/items"}.
Inside templates use RELATIVE binding paths (no leading slash), e.g. {"path":"name"}.
Pick the card type that best matches the request and generate 3-4 realistic items.

After sending the UI, do NOT repeat the data in text — the tool renders it. Just confirm."""

# One in-context example (Google's SDK normally loads these from a path; we inline a
# compact valid surface so the live model has a concrete shape to follow).
A2UI_EXAMPLES = """### Example (hotel comparison)
Every message MUST include "version":"v0.9".
<a2ui-json>
[
  {"version":"v0.9","createSurface":{"surfaceId":"hotel-comparison","catalogId":"https://a2ui.org/demos/dojo/dynamic_catalog.json"}},
  {"version":"v0.9","updateComponents":{"surfaceId":"hotel-comparison","components":[
    {"id":"root","component":"Row","gap":16,"children":{"componentId":"card","path":"/items"}},
    {"id":"card","component":"HotelCard","name":{"path":"name"},"location":{"path":"location"},"rating":{"path":"rating"},"pricePerNight":{"path":"pricePerNight"},"action":{"event":{"name":"book","context":{"name":{"path":"name"}}}}}
  ]}},
  {"version":"v0.9","updateDataModel":{"surfaceId":"hotel-comparison","path":"/","value":{"items":[
    {"name":"The Ritz","location":"Paris","rating":4.8,"pricePerNight":"$450/night"}
  ]}}}
]
</a2ui-json>"""
