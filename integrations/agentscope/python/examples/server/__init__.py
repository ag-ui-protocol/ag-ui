"""AgentScope examples for the AG-UI Dojo."""

import os

import uvicorn
from fastapi import FastAPI

from .agents import agent_factory
from .bridge import create_agent_app

app = FastAPI(title="AgentScope AG-UI examples")
app.mount("/agentic_chat", create_agent_app(agent_factory(with_weather=False)))
app.mount("/backend_tool_rendering", create_agent_app(agent_factory(with_weather=True)))


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


def main() -> None:
    uvicorn.run(
        "server:app",
        host=os.getenv("HOST", "0.0.0.0"),
        port=int(os.getenv("PORT", "8031")),
    )
