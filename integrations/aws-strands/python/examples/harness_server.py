"""A Strands harness served over AG-UI.

Not one of the dojo demos under ``server/`` (``server/harness.py`` serves those
on a harness with its own tools off): this is a harness as it comes, and it
runs commands on this machine. Start it by itself:

    poetry run python harness_server.py

then point any AG-UI client at ``http://localhost:8001/``.

Environment:

    HARNESS_MODEL          ``provider/name``, or a bare Bedrock model id. Unset,
                           the harness default: Claude Opus on Amazon Bedrock,
                           with the AWS credentials of this process.
    HARNESS_INTERVENTIONS  ``ask`` (the default here), ``smart``, ``off``, or a
                           policy in plain words. The harness's own default is
                           off; this server asks, because its shell is yours.
    HARNESS_WORKSPACE      The directory the agent works in. Default ./workspace.
    HARNESS_CORS_ORIGINS   Comma-separated origins. Default http://localhost:3000.
    PORT                   Default 8001.
"""

import os
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_strands import StrandsHarnessAgent, add_ping, add_strands_fastapi_endpoint

workspace = Path(os.getenv("HARNESS_WORKSPACE", "workspace")).resolve()
workspace.mkdir(parents=True, exist_ok=True)
# The harness resolves ./.agent and its tools' working directory from here.
os.chdir(workspace)

interventions = os.getenv("HARNESS_INTERVENTIONS", "ask")

agent = StrandsHarnessAgent(
    name="harness",
    description="A Strands harness: shell, files, web, subagents",
    harness={
        # None is "the harness default", which is Bedrock.
        "model": os.getenv("HARNESS_MODEL") or None,
        # Every shell command and file write pauses the run for an approval the
        # client answers, as a `tool_call` interrupt.
        "interventions": None if interventions == "off" else interventions,
        # One memory store for everybody this process serves is the wrong
        # default for a server. Give each user a directory to turn it on.
        "memory": False,
    },
)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    # Closes what outlives a run: MCP connections, background tasks.
    await agent.shutdown()


app = FastAPI(title="Strands harness over AG-UI", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv("HARNESS_CORS_ORIGINS", "http://localhost:3000").split(",")
        if origin.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)
add_strands_fastapi_endpoint(app, agent, "/")
add_ping(app, "/ping")


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8001")))
