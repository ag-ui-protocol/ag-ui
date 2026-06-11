"""Google-A2UI-Agent-SDK proof-point — dynamic schema (parallel to a2ui_dynamic_schema).

Same ADK feature as the toolkit-based ``a2ui_dynamic_schema``, but generation +
validation are driven by **Google's** ``a2ui-agent-sdk`` (via ``GoogleA2uiSendTool`` in
``_google_a2ui_common``) instead of our ``ag-ui-a2ui-toolkit``. The model calls the
``send_a2ui_json_to_client`` tool; the tool validates/heals with Google's SDK and
returns ``{"validated_a2ui_json": [...]}``. A dojo-local shim normalizes that into the
``a2ui_operations`` envelope the CopilotKit A2UI middleware paints.
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.models import Gemini

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from ._google_a2ui_common import ROLE_DESCRIPTION, build_a2ui_tool

# gemini-2.5-pro reliably produces valid, in-catalog A2UI for this demo.
_MODEL = "gemini-2.5-pro"

google_dynamic_schema_agent = LlmAgent(
    model=Gemini(model=_MODEL),
    name="google_a2ui_dynamic_schema",
    instruction=ROLE_DESCRIPTION,  # tool appends catalog schema + examples
    tools=[build_a2ui_tool()],
)

adk_google_a2ui_dynamic_schema = ADKAgent(
    adk_agent=google_dynamic_schema_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Dynamic Schema (Google A2UI Agent SDK)")
add_adk_fastapi_endpoint(app, adk_google_a2ui_dynamic_schema, path="/")
