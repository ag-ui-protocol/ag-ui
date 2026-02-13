"""AG2 AG-UI example server for the Dojo.

Exposes AG-UI compatible endpoints using AG2's AGUIStream.
"""

from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI

load_dotenv()

from .api import agentic_chat

app = FastAPI(title="AG2 AG-UI server")
app.mount("/agentic_chat", agentic_chat.agentic_chat_app, "Agentic Chat")


def main():
    """Start the FastAPI server."""
    port = int(os.getenv("PORT", "8018"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
