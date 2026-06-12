"""Google-A2UI-Agent-SDK proof-point — STREAMING (Option A).

Demonstrates Google's prompt-based streaming path: the model emits A2UI inline as
`<a2ui-json>` text, Google's `A2uiStreamParser` yields components incrementally, and
`GoogleA2uiStreamingTool` bridges those yields to progressive `a2ui-surface`
ACTIVITY_SNAPSHOT events that the dojo renderer paints as they arrive.

Unlike the other two Google demos, this one does NOT attach the CopilotKit A2UI
middleware — Google's streaming model (forward-ref placeholders + incremental
updateComponents) doesn't compose with the middleware's append-only, validation-gated
render_a2ui path, so the surface activity is emitted directly. See
``_google_a2ui_streaming.py`` and ``GOOGLE_A2UI_PROOF_POINT.md`` for the why.
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.models import Gemini

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from ._google_a2ui_common import DYNAMIC_CATALOG_ID, build_schema_manager
from ._google_a2ui_streaming import GoogleA2uiStreamingTool

_MODEL = "gemini-2.5-pro"

_schema_manager = build_schema_manager()
_streaming_tool = GoogleA2uiStreamingTool(
    model=Gemini(model=_MODEL),
    schema_manager=_schema_manager,
    catalog=_schema_manager.get_selected_catalog(),
    default_catalog_id=DYNAMIC_CATALOG_ID,
)

SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (hotel/product/team comparisons, lists, cards),
call the generate_a2ui_streaming tool to render it. The tool streams the surface to the
client as it is generated. After calling it, do NOT repeat the data in your text reply —
just briefly confirm what was rendered."""

google_streaming_agent = LlmAgent(
    model=Gemini(model=_MODEL),
    name="google_a2ui_streaming",
    instruction=SYSTEM_PROMPT,
    tools=[_streaming_tool],
)

adk_google_a2ui_streaming = ADKAgent(
    adk_agent=google_streaming_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Streaming (Google A2UI Agent SDK)")
add_adk_fastapi_endpoint(app, adk_google_a2ui_streaming, path="/")
