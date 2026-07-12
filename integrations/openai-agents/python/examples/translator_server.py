"""
Multi-agent example server — the translator by hand. Recommended.

Wires the translator directly — to_sdk, Runner.run_streamed, to_agui — so the
full run loop is visible in one place. AGUITranslator is just an events
translator: this file keeps full control of the agent and the server. Same
demos and output as server.py, which builds the same thing with the
OpenAIAgentsAgent + add_openai_agents_fastapi_endpoint serve layer — an
opinionated shortcut that trades that control for less code.

One FastAPI route per demo, all sharing the same run loop:

    POST /agentic_chat              ← plain conversation
    POST /backend_tool_rendering    ← server-executed @function_tool
    POST /human_in_the_loop         ← frontend-owned tool, StopAtTools
    POST /tool_based_generative_ui  ← frontend tool renders the content
    POST /handoff                   ← multi-agent triage via handoffs=
    POST /orchestrator              ← multi-agent via agents-as-tools
    POST /custom_lifecycle_events   ← manual CUSTOM event right after RUN_STARTED
                                       and right before RUN_FINISHED, via
                                       DemoConfig.build_start_custom_event /
                                       build_end_custom_event

    GET  /health                    ← liveness check

Stateful demos (shared_state, agentic_generative_ui,
predictive_state_updates) are shelved with ``AGUIContext`` — see
``.dev/shelved/``.

Run:
    OPENAI_API_KEY=sk-... uv run python translator_server.py

    # Auto-restart on code changes (this file, agents_examples/, or the
    # package's own src/ — an editable install, so plain `uvicorn.run(app)`
    # never notices those edits on its own):
    RELOAD=1 OPENAI_API_KEY=sk-... uv run python translator_server.py

Test:
    curl -N -X POST http://localhost:8022/agentic_chat \\
      -H 'Content-Type: application/json' \\
      -d '{
        "thread_id": "t1",
        "run_id":    "r1",
        "messages":  [{"id":"m1","role":"user","content":"Say hi in one sentence."}],
        "tools":     [],
        "state":     {},
        "context":   [],
        "forwarded_props": null
      }'

Expected event order for that request:
    RUN_STARTED → STATE_SNAPSHOT → TEXT_MESSAGE_START → TEXT_MESSAGE_CONTENT (×N)
    → TEXT_MESSAGE_END → MESSAGES_SNAPSHOT → RUN_FINISHED
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import uvicorn
from agents import Runner
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse

from ag_ui_openai_agents import AGUITranslator

from agents_examples import DemoConfig, build_registry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Demo registry — one entry per demo, keyed by URL path
# ---------------------------------------------------------------------------

DEMOS: dict[str, DemoConfig] = build_registry()

# The translator is stateless/reusable — one instance serves every request; each
# to_agui call creates the fresh per-run engine it needs internally.
translator = AGUITranslator()

# AG-UI's own SSE encoder: one `data: <json>\n\n` frame per event.
encoder = EventEncoder()

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="AG-UI × OpenAI Agents SDK examples")


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "agents": list(DEMOS)}


@app.post("/{agent_name}")
async def run(agent_name: str, body: RunAgentInput) -> StreamingResponse:
    """Accept a RunAgentInput, run the named demo agent, stream AG-UI events back via SSE."""
    demo = DEMOS.get(agent_name)
    if demo is None:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name!r}")
    return StreamingResponse(_stream(demo, body), media_type=encoder.get_content_type())


# ---------------------------------------------------------------------------
# Core streaming logic — shared by every demo in the registry
# ---------------------------------------------------------------------------


async def _stream(demo: DemoConfig, body: RunAgentInput):
    """
    Translate the AG-UI input → run the SDK agent → translate events back.

    Each yielded chunk is one SSE line: ``data: <json>\\n\\n``
    """
    # 1 — Translate AG-UI input into SDK-ready shapes.
    translated = translator.to_sdk(body)

    # Frontend (client-owned) tools declared on this request — e.g. the
    # human_in_the_loop demo's `generate_task_steps`. Merged per-request
    # rather than baked into the Agent, since they come from the wire.
    agent = demo.agent
    if translated.tools:
        agent = agent.clone(tools=[*agent.tools, *translated.tools])

    # Demo-specific lifecycle hooks (only custom_lifecycle_events sets these) —
    # start_custom_event/end_custom_event only accept CustomEvent instances
    # (anything else raises TypeError), so building them here, not inline,
    # keeps this loop demo-agnostic: it just forwards whatever the registry
    # gave it.
    to_agui_kwargs = {}
    if demo.build_start_custom_event:
        to_agui_kwargs["start_custom_event"] = demo.build_start_custom_event()
    if demo.build_end_custom_event:
        to_agui_kwargs["end_custom_event"] = demo.build_end_custom_event()

    # 2 — Run the agent; to_agui() wraps the stream with the lifecycle events
    #     (RUN_STARTED first, RUN_FINISHED / RUN_ERROR last), echoes the state
    #     snapshot, handles window bookkeeping + the final flush, and appends a
    #     trailing MESSAGES_SNAPSHOT. Nothing to hand-emit here.
    try:
        result = Runner.run_streamed(agent, input=translated.messages)
        async for ag_event in translator.to_agui(result, body, **to_agui_kwargs):
            yield encoder.encode(ag_event)
    except Exception:
        # to_agui already emitted RUN_ERROR before re-raising; just log here so
        # the real traceback lands in the server logs.
        logger.exception("Agent run failed")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> int:
    if not os.getenv("OPENAI_API_KEY"):
        print("Error: OPENAI_API_KEY required")
        return 1
    # 8022 is the port the AG-UI Dojo expects for this integration
    # (apps/dojo/src/env.ts — OPENAI_AGENTS_PYTHON_URL).
    port = int(os.getenv("PORT", "8022"))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting server on port {port} — agents: {list(DEMOS)}")
    if os.getenv("RELOAD"):
        uvicorn.run(
            "translator_server:app",
            host=host,
            port=port,
            reload=True,
            reload_dirs=[str(Path(__file__).parent), str(Path(__file__).parent.parent / "src")],
            log_level="info",
        )
    else:
        uvicorn.run(app, host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
