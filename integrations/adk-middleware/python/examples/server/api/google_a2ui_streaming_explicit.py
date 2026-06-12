"""Google-A2UI-Agent-SDK proof-point — EXPLICIT streaming (Option B).

Variant of `google_a2ui_streaming` that makes component-level streaming **visible**.

The template-over-data streaming demo emits all components first (a `Row` repeating a
card template over `/items`) and then the data model — but data-bound templates render
nothing until the data arrives, so the visible build-up is compressed into the data
phase at the end. Here we instead instruct the model to emit **explicit components with
inline literal values** and a **static `children` array** (no template, no data model),
so each card paints the instant its component streams in — genuine component-by-component
streaming, which is what Google's `A2uiStreamParser` is built for.

Same bridge (`GoogleA2uiStreamingTool` → progressive `a2ui-surface` ACTIVITY_SNAPSHOTs,
no middleware); only the generation prompt differs.
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.models import Gemini

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from ._google_a2ui_common import DYNAMIC_CATALOG_ID, build_schema_manager
from ._google_a2ui_streaming import GoogleA2uiStreamingTool

_MODEL = "gemini-2.5-pro"

# Explicit-mode role: literal values + static children array, NO template, NO data model.
EXPLICIT_ROLE_DESCRIPTION = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product/team comparisons, lists, cards),
generate an A2UI surface. You have 4 components: Row, HotelCard, ProductCard,
TeamMemberCard.

Build the surface with EXPLICIT components and INLINE LITERAL values — do NOT use a
repeating template and do NOT use a data model:
- `root` is a Row whose `children` is a STATIC ARRAY of component ids, e.g.
  {"id":"root","component":"Row","gap":16,"children":["card-1","card-2","card-3"]}.
- Create one explicit card component per item (matching the request), each with its
  values written INLINE as literals — e.g. "name":"The Ritz","rating":4.8,
  "pricePerNight":"$950/night" — NOT {"path":...} bindings.
- Do NOT emit updateDataModel; there is no data model in this mode.
- Emit components TOP-DOWN: root first, then each card in order. This lets each card
  stream in and paint as it arrives.

Generate 3-4 realistic items. After emitting, do NOT repeat the data in text."""

# A concrete, version-bearing, explicit (no-template, no-data) example to anchor format.
EXPLICIT_EXAMPLE = """### Example (explicit hotel comparison — literal values, static children, no data model)
Every message MUST include "version":"v0.9".
<a2ui-json>
[
  {"version":"v0.9","createSurface":{"surfaceId":"hotel-comparison","catalogId":"https://a2ui.org/demos/dojo/dynamic_catalog.json"}},
  {"version":"v0.9","updateComponents":{"surfaceId":"hotel-comparison","components":[
    {"id":"root","component":"Row","gap":16,"children":["hotel-1","hotel-2","hotel-3"]},
    {"id":"hotel-1","component":"HotelCard","name":"The Ritz Paris","location":"Paris","rating":4.8,"pricePerNight":"$950/night","action":{"event":{"name":"book","context":{"name":"The Ritz Paris"}}}},
    {"id":"hotel-2","component":"HotelCard","name":"Aman Tokyo","location":"Tokyo","rating":4.9,"pricePerNight":"$1200/night","action":{"event":{"name":"book","context":{"name":"Aman Tokyo"}}}},
    {"id":"hotel-3","component":"HotelCard","name":"Belmond Cipriani","location":"Venice","rating":4.7,"pricePerNight":"$1100/night","action":{"event":{"name":"book","context":{"name":"Belmond Cipriani"}}}}
  ]}}
]
</a2ui-json>"""

_schema_manager = build_schema_manager()
_streaming_tool = GoogleA2uiStreamingTool(
    model=Gemini(model=_MODEL),
    schema_manager=_schema_manager,
    catalog=_schema_manager.get_selected_catalog(),
    default_catalog_id=DYNAMIC_CATALOG_ID,
    role_description=EXPLICIT_ROLE_DESCRIPTION,
    example=EXPLICIT_EXAMPLE,
)

SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content, call the generate_a2ui_streaming tool to render
it. The tool streams the surface to the client as it is generated. After calling it, do
NOT repeat the data in your text reply — just briefly confirm what was rendered."""

google_streaming_explicit_agent = LlmAgent(
    model=Gemini(model=_MODEL),
    name="google_a2ui_streaming_explicit",
    instruction=SYSTEM_PROMPT,
    tools=[_streaming_tool],
)

adk_google_a2ui_streaming_explicit = ADKAgent(
    adk_agent=google_streaming_explicit_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Streaming — Explicit (Google A2UI Agent SDK)")
add_adk_fastapi_endpoint(app, adk_google_a2ui_streaming_explicit, path="/")
