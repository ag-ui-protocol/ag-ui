"""HeartbeatPlugin keep-alive feature.

Demonstrates keeping the SSE stream alive during a long-running tool with
``HeartbeatPlugin``. While ``slow_research`` sleeps, the plugin emits
``ACTIVITY_SNAPSHOT`` events every ``interval_seconds`` so timeout-sensitive
infrastructure (Lambda/API Gateway, Cloud Run, proxies, CDNs) doesn't drop the
connection before the tool returns.

Key points:
1. Plugins are only honored on the App path — build the agent with
   ``ADKAgent.from_app(...)``, not the plain ``ADKAgent(adk_agent=...)`` form.
2. Each tool call emits ``starting`` → ``processing`` (every interval) →
   ``complete``/``error``, with progress carried in the event ``content``.
3. ``emit_progress(...)`` can be called from inside a tool for richer,
   tool-driven progress updates.
"""

from __future__ import annotations

import asyncio

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, AGUIToolset, HeartbeatPlugin, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk.apps import App


async def slow_research(topic: str) -> str:
    """Simulate a slow, long-running tool (e.g. scraping or document processing)."""
    await asyncio.sleep(15)
    return f"Finished researching '{topic}'."


sample_agent = LlmAgent(
    name="assistant",
    model="gemini-3.5-flash",
    instruction=(
        "You are a research assistant. When the user asks you to research a topic, "
        "call the slow_research tool and then summarize its result."
    ),
    tools=[
        slow_research,
        AGUIToolset(),  # Tools provided by the AG-UI client
    ],
)

# Plugins are wired through the App, so use from_app() (not ADKAgent(adk_agent=...)).
app_def = App(
    name="demo_app",
    root_agent=sample_agent,
    plugins=[HeartbeatPlugin(interval_seconds=5.0)],
)

heartbeat_agent = ADKAgent.from_app(
    app_def,
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
)

# Create FastAPI app
app = FastAPI(title="ADK Middleware Heartbeat Keep-Alive")

# Add the ADK endpoint
add_adk_fastapi_endpoint(app, heartbeat_agent, path="/")
