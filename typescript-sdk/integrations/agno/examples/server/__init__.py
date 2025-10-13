"""Example usage of the AG-UI adapter for Agno.

This provides a FastAPI application that demonstrates how to use the
Agno agent with the AG-UI protocol. It includes examples for
AG-UI dojo features:
- Agentic Chat (Investment Analyst with Finance tools)
"""
from __future__ import annotations

from fastapi import FastAPI
import uvicorn
import os
from dotenv import load_dotenv
load_dotenv()

from .api import (
    agentic_chat_app,
    tool_based_generative_ui_app,
    backend_tool_rendering_app,
)

app = FastAPI(title='Agno AG-UI server')
app.mount('/agentic_chat', agentic_chat_app, 'Agentic Chat')
app.mount('/tool_based_generative_ui', tool_based_generative_ui_app, 'Tool-based Generative UI')
app.mount('/backend_tool_rendering', backend_tool_rendering_app, 'Backend Tool Rendering')

def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "9001"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main"]
