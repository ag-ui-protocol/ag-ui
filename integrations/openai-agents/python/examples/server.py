"""
Multi-agent example server — the wrapper style (an opinionated shortcut).

Built with the package's serve layer: each demo is one OpenAIAgentsAgent + one
add_openai_agents_fastapi_endpoint call; the wrapper does to_sdk /
Runner.run_streamed / to_agui / SSE / lifecycle for you. Trades away the
control translator_server.py gives you (agent config fixed at construction,
server is FastAPI) for less code.

Compare with translator_server.py (the translator by hand, recommended) to
see the trade: this file is shorter and has no run loop to get wrong;
translator_server.py shows every step and lets you branch mid-run.

    POST /agentic_chat              ← plain conversation
    POST /backend_tool_rendering    ← server-executed @function_tool
    POST /human_in_the_loop         ← frontend-owned tool, StopAtTools
    POST /tool_based_generative_ui  ← frontend tool renders the content
    POST /subagents                 ← multi-agent via agents-as-tools
    POST /custom_lifecycle_events   ← manual CUSTOM event bracketing the run
                                       (routed by hand — see below)
    POST /dynamic_system_prompt     ← system prompt built from RunAgentInput.context
                                       (routed by hand — see below)
    POST /human_in_the_loop_approval ← backend tool gated by needs_approval,
                                       resumed from result.interruptions
                                       (routed by hand — see below)

    GET  /health                    ← liveness check (lists all demos)
    GET  /<demo>/health             ← per-demo check

Run:
    OPENAI_API_KEY=sk-... uv run python server.py

    # Auto-restart on code changes (this file, agents_examples/, or the
    # package's own src/ — an editable install, so plain `uvicorn.run(app)`
    # never notices those edits on its own):
    RELOAD=1 OPENAI_API_KEY=sk-... uv run python server.py

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
from ag_ui.core import CustomEvent, EventType, RunAgentInput
from ag_ui.encoder import EventEncoder
from fastapi import FastAPI
from fastapi.responses import StreamingResponse

from ag_ui_openai_agents import (
    AGUITranslator,
    OpenAIAgentsAgent,
    add_openai_agents_fastapi_endpoint,
)

from agents_examples import DemoConfig, build_registry
from agents_examples.dynamic_system_prompt import stream as dsp_stream

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEMOS: dict[str, DemoConfig] = build_registry()

app = FastAPI(title="AG-UI × OpenAI Agents SDK examples (wrapper)")

# The whole run loop: one wrapped agent + one endpoint per demo. Three demos
# need more than the wrapper can give them, so they're routed by hand below
# instead of through this loop:
#   - custom_lifecycle_events: OpenAIAgentsAgent.run() calls
#     to_agui(result, input) with no extra kwargs, so the wrapper can't
#     forward DemoConfig.build_start_custom_event/build_end_custom_event —
#     the CUSTOM events would silently never go out.
#   - dynamic_system_prompt: OpenAIAgentsAgent.run() never passes context=
#     to Runner.run_streamed, so the demo's whole point (reading
#     RunAgentInput.context) would silently do nothing.
#   - human_in_the_loop_approval: needs to inspect result.interruptions after the stream
#     and, on the next request, resume from a stored RunState instead of
#     translated.messages — the wrapper always starts fresh from the input.
_HAND_ROUTED = {"custom_lifecycle_events", "dynamic_system_prompt", "human_in_the_loop_approval"}

for demo_name, demo in DEMOS.items():
    if demo_name in _HAND_ROUTED:
        continue
    add_openai_agents_fastapi_endpoint(
        app,
        OpenAIAgentsAgent(demo.agent, name=demo_name),
        f"/{demo_name}",
    )

_lifecycle_translator = AGUITranslator()
_lifecycle_encoder = EventEncoder()
_lifecycle_demo = DEMOS["custom_lifecycle_events"]


@app.post("/custom_lifecycle_events")
async def _run_custom_lifecycle_events(body: RunAgentInput) -> StreamingResponse:
    async def _stream():
        translated = _lifecycle_translator.to_sdk(body)
        agent = _lifecycle_demo.agent
        if translated.tools:
            agent = agent.clone(tools=[*agent.tools, *translated.tools])
        kwargs = {}
        if _lifecycle_demo.build_start_custom_event is not None:
            kwargs["start_custom_event"] = _lifecycle_demo.build_start_custom_event()
        if _lifecycle_demo.build_end_custom_event is not None:
            kwargs["end_custom_event"] = _lifecycle_demo.build_end_custom_event()
        result = Runner.run_streamed(agent, input=translated.messages)
        async for ag_event in _lifecycle_translator.to_agui(result, body, **kwargs):
            yield _lifecycle_encoder.encode(ag_event)

    return StreamingResponse(_stream(), media_type=_lifecycle_encoder.get_content_type())


_dsp_encoder = EventEncoder()


@app.post("/dynamic_system_prompt")
async def _run_dynamic_system_prompt(body: RunAgentInput) -> StreamingResponse:
    async def _stream():
        async for ag_event in dsp_stream(body):
            yield _dsp_encoder.encode(ag_event)

    return StreamingResponse(_stream(), media_type=_dsp_encoder.get_content_type())


_approval_translator = AGUITranslator()
_approval_encoder = EventEncoder()
_approval_demo = DEMOS["human_in_the_loop_approval"]

# thread_id -> paused RunState, waiting for an approve/reject decision on the
# next request. In-memory only — fine for a demo process, not a restart or a
# second server instance; a real app would use a session store instead.
_PENDING_APPROVALS: dict[str, object] = {}


@app.post("/human_in_the_loop_approval")
async def _run_approval(body: RunAgentInput) -> StreamingResponse:
    async def _stream():
        agent = _approval_demo.agent
        decision = None
        forwarded = body.forwarded_props
        if isinstance(forwarded, dict):
            decision = forwarded.get("approval")

        pending_state = _PENDING_APPROVALS.pop(body.thread_id, None)
        if decision and pending_state is not None:
            item = next(
                (
                    i
                    for i in pending_state.get_interruptions()
                    if getattr(i.raw_item, "call_id", None) == decision.get("call_id")
                ),
                None,
            )
            if item is not None:
                if decision.get("approve"):
                    pending_state.approve(item)
                else:
                    pending_state.reject(item)
            result = Runner.run_streamed(agent, pending_state)
        else:
            translated = _approval_translator.to_sdk(body)
            if translated.tools:
                agent = agent.clone(tools=[*agent.tools, *translated.tools])
            result = Runner.run_streamed(agent, input=translated.messages)

        # result.interruptions is only known once the SDK's own stream is
        # fully drained — there's no mid-stream event for it. to_agui()
        # always puts RUN_FINISHED last, and the client drops anything that
        # arrives after RUN_FINISHED (a finished run is done, full stop) —
        # so the approval CustomEvent has to go out as end_custom_event
        # (right before RUN_FINISHED), which means draining the raw SDK
        # stream ourselves first instead of handing `result` straight to
        # to_agui: end_custom_event has to already exist by the time we
        # call it, and interruptions aren't known until the drain finishes.
        raw_events = [event async for event in result.stream_events()]

        end_custom_event = None
        if result.interruptions:
            _PENDING_APPROVALS[body.thread_id] = result.to_state()
            end_custom_event = CustomEvent(
                type=EventType.CUSTOM,
                name="approval_request",
                value=[
                    {
                        "call_id": getattr(item.raw_item, "call_id", None),
                        "tool_name": item.tool_name,
                        "arguments": getattr(item.raw_item, "arguments", None),
                    }
                    for item in result.interruptions
                ],
            )

        async def _replay():
            for event in raw_events:
                yield event

        async for ag_event in _approval_translator.to_agui(
            _replay(), body, end_custom_event=end_custom_event
        ):
            yield _approval_encoder.encode(ag_event)

    return StreamingResponse(_stream(), media_type=_approval_encoder.get_content_type())


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "agents": list(DEMOS)}


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
            "server:app",
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
