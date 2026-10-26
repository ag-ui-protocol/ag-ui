"""Generative UI feature.

CopilotKit sends its generative UI guide and component schema as the run's
context. The middleware stores the context in session state under
CONTEXT_STATE_KEY; the instruction provider appends it, so the agent can
answer with ```a2ui fences or call the render_ui frontend tool.
"""

from __future__ import annotations

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, AGUIToolset, CONTEXT_STATE_KEY, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext


def instruction_with_context(ctx: ReadonlyContext) -> str:
    """The instruction with the application's context entries appended."""
    entries = [
        f"{item['description']}:\n{item['value']}"
        for item in ctx.state.get(CONTEXT_STATE_KEY) or []
        if item.get("value")
    ]
    instruction = "You are a helpful assistant."
    if entries:
        instruction += "\n\n## Context from the application\n\n" + "\n\n".join(entries)
    return instruction


generative_ui_agent = LlmAgent(
    name="assistant",
    model="gemini-2.5-flash",
    instruction=instruction_with_context,
    tools=[AGUIToolset()],  # The tools provided by the AG-UI client, e.g. render_ui
)

adk_generative_ui_agent = ADKAgent(
    adk_agent=generative_ui_agent,
    app_name="demo_app",
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

app = FastAPI(title="ADK Middleware Generative UI")

add_adk_fastapi_endpoint(app, adk_generative_ui_agent, path="/")
