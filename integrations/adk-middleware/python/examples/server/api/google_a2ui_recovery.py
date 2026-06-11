"""Google-A2UI-Agent-SDK proof-point — error recovery (parallel to a2ui_recovery).

Same scenario as the toolkit-based ``a2ui_recovery`` demo, but the agent uses Google's
``a2ui-agent-sdk``. The contrast this demo exists to show:

  * Our toolkit build runs a **bounded** validate->retry loop
    (``run_a2ui_generation_with_recovery``) and emits an ``a2ui_recovery_exhausted``
    hard-failure envelope after N attempts.
  * Google's SDK has **no recovery loop**: ``send_a2ui_json_to_client`` validates once
    and, on failure, returns ``{"error": "..."}`` to the model. Any retry is therefore
    **model-driven** (the LLM may choose to re-call the tool after seeing the error) and
    **unbounded** — there is no structured cap and no hard-failure UX. The CopilotKit
    A2UI middleware still paint-gates (an invalid surface never paints), but it does not
    drive regeneration.

Construction is identical to the dynamic-schema agent; the difference is purely in the
demo flow (the model first emits an invalid surface, then a valid one) and is exercised
by the aimock fixtures / e2e specs.
"""

from __future__ import annotations

from fastapi import FastAPI
from google.adk.agents import LlmAgent
from google.adk.models import Gemini

from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint

from ._google_a2ui_common import ROLE_DESCRIPTION, build_a2ui_tool

_MODEL = "gemini-2.5-pro"

google_recovery_agent = LlmAgent(
    model=Gemini(model=_MODEL),
    name="google_a2ui_recovery",
    instruction=ROLE_DESCRIPTION,
    tools=[build_a2ui_tool()],
)

adk_google_a2ui_recovery = ADKAgent(
    adk_agent=google_recovery_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware A2UI Recovery (Google A2UI Agent SDK)")
add_adk_fastapi_endpoint(app, adk_google_a2ui_recovery, path="/")
