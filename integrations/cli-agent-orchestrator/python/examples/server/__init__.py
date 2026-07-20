"""
CLI Agent Orchestrator dojo example server for the AG-UI protocol.

Demonstrates agentic chat, shared state, human-in-the-loop,
and the interrupt/approval lifecycle without requiring a real CAO backend.
"""

import os
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .agentic_chat import agentic_chat_endpoint
from .shared_state import shared_state_endpoint
from .human_in_the_loop import human_in_the_loop_endpoint
from .interrupt import interrupt_endpoint

app = FastAPI(title="CLI Agent Orchestrator - AG-UI Dojo Server")

# CORS: follow the upstream CORS_ALLOW_ORIGINS convention (ag-ui 3b370a5).
# Never combine allow_credentials=True with a wildcard origin.
_cors_origins_raw = os.getenv("CORS_ALLOW_ORIGINS", "*")
_cors_origins = [o.strip() for o in _cors_origins_raw.split(",") if o.strip()]
_is_wildcard = _cors_origins == ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=not _is_wildcard,  # credentials only for explicit origins
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Root health check endpoint (upstream convention from ag-ui 691dae8)."""
    return {"status": "ok"}


# Register endpoints with hyphenated paths matching agents.ts path mappings
app.post("/agentic-chat")(agentic_chat_endpoint)
app.post("/shared-state")(shared_state_endpoint)
app.post("/human-in-the-loop")(human_in_the_loop_endpoint)
app.post("/interrupt")(interrupt_endpoint)


def main():
    """Run the uvicorn server."""
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8024"))
    uvicorn.run("server:app", host=host, port=port, reload=True)
