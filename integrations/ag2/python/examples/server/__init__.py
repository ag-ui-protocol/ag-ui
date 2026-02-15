"""AG2 AG-UI example server for the Dojo.

Exposes AG-UI compatible endpoints using AG2's AGUIStream.
"""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from .api import agentic_chat, backend_tool_rendering, human_in_the_loop

app = FastAPI(title="AG2 AG-UI server")
app.mount("/agentic_chat", agentic_chat.agentic_chat_app, "Agentic Chat")
app.mount("/backend_tool_rendering", backend_tool_rendering.backend_tool_rendering_app, "Backend Tool Rendering")
app.mount("/human_in_the_loop", human_in_the_loop.human_in_the_loop_app, "Human in the Loop")


def main():
    """Start the FastAPI server."""
    port = int(os.getenv("PORT", "8018"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)


if __name__ == "__main__":
    main()

__all__ = ["main"]
