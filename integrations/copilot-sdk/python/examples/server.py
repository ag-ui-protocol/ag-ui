"""Multi-agent server for the GitHub Copilot SDK integration.

The agent owns the native SDK session lifecycle — the server just calls
``agent.run(input_data)`` and streams the resulting AG-UI events.

Usage:
    uv run --extra server python examples/server.py

Set ``OPENAI_BASE_URL`` (and ``OPENAI_API_KEY``) to route inference at an
OpenAI-compatible endpoint through the SDK's BYOK provider — that is how the
Dojo e2e suites drive this server against the pinned mock model server. Without
it the SDK uses the machine's logged-in Copilot account.

The example binds to loopback and is unauthenticated; it is a demo, not a
deployment template.
"""

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

import uvicorn
from copilot import CopilotClient
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_copilot_sdk import add_copilot_fastapi_endpoint

sys.path.insert(0, str(Path(__file__).parent))

from agents.agentic_chat import create_agentic_chat_agent

AGENT_FACTORIES = {
    "agentic_chat": create_agentic_chat_agent,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    with TemporaryDirectory(prefix="copilot-sdk-dojo-") as runtime:
        client = CopilotClient(
            mode="empty",
            log_level="error",
            base_directory=runtime,
            # BYOK runs bypass Copilot API auth entirely.
            use_logged_in_user=not os.getenv("OPENAI_BASE_URL"),
        )
        await client.start()
        agents = {name: factory(client) for name, factory in AGENT_FACTORIES.items()}
        for name, agent in agents.items():
            add_copilot_fastapi_endpoint(app=app, agent=agent, path=f"/{name}")
        try:
            yield
        finally:
            for agent in agents.values():
                await agent.close()
            await client.stop()


app = FastAPI(title="GitHub Copilot SDK Server", lifespan=lifespan)

# Allowed CORS origins come from CORS_ALLOW_ORIGINS (comma-separated) and default
# to the "*" wildcard for local development. Credentials are only enabled for
# explicit, non-wildcard origins — a wildcard can never be combined with
# allow_credentials=True (any site could then read authenticated responses).
_origins = [o.strip() for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins or ["*"],
    allow_credentials=bool(_origins) and "*" not in _origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "healthy", "agents": len(AGENT_FACTORIES)}


def main():
    port = int(os.getenv("PORT", "8027"))
    host = os.getenv("HOST", "127.0.0.1")
    print(f"Starting server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
