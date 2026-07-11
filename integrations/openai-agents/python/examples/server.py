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
    POST /handoff                   ← multi-agent triage via handoffs=
    POST /orchestrator              ← multi-agent via agents-as-tools

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
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint

from agents_examples import DemoConfig, build_registry

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

DEMOS: dict[str, DemoConfig] = build_registry()

app = FastAPI(title="AG-UI × OpenAI Agents SDK examples (wrapper)")

# The whole run loop: one wrapped agent + one endpoint per demo.
for demo_name, demo in DEMOS.items():
    add_openai_agents_fastapi_endpoint(
        app,
        OpenAIAgentsAgent(demo.agent, name=demo_name),
        f"/{demo_name}",
    )


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
