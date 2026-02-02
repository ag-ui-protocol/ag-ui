"""Example usage of the AG-UI OpenResponses integration.

This provides a FastAPI application that demonstrates how to use the
OpenResponses agent with the AG-UI protocol. It connects to any
OpenResponses-compatible endpoint (OpenAI, Azure, HuggingFace, OpenClaw).
"""

from __future__ import annotations

import logging
import os

import uvicorn

logging.basicConfig(level=logging.INFO)
logging.getLogger("ag_ui_openresponses").setLevel(logging.DEBUG)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from .api import (
    agentic_chat_app,
    human_in_the_loop_app,
    tool_based_generative_ui_app,
)

app = FastAPI(title='OpenResponses AG-UI Server')

# Enable CORS for Dojo app
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount('/agentic_chat', agentic_chat_app, 'Agentic Chat')
app.mount('/human_in_the_loop', human_in_the_loop_app, 'Human in the Loop')
app.mount('/tool_based_generative_ui', tool_based_generative_ui_app, 'Tool-Based Generative UI')


@app.get("/health")
async def health():
    """Health check endpoint."""
    return {"status": "ok"}


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "8018"))
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
