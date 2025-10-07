"""Example usage of the AG-UI adapter for Pydantic AI.

This provides a FastAPI application that demonstrates how to use the
Pydantic AI agent with the AG-UI protocol. It includes examples for
each of the AG-UI dojo features:
- Agentic Chat
- Human in the Loop
- Agentic Generative UI
- Tool Based Generative UI
- Shared State
- Predictive State Updates
"""

from __future__ import annotations

from fastapi import FastAPI
import uvicorn
import os


from .api import (
    agentic_chat_app,
    agentic_generative_ui_app,
    backend_tool_rendering_app,
    human_in_the_loop_app,
    predictive_state_updates_app,
    shared_state_app,
    tool_based_generative_ui_app,
)

app = FastAPI(title='Pydantic AI AG-UI server')
app.mount('/agentic_chat', agentic_chat_app, 'Agentic Chat')
app.mount('/agentic_generative_ui', agentic_generative_ui_app, 'Agentic Generative UI')
app.mount('/backend_tool_rendering', backend_tool_rendering_app, 'Backend Tool Rendering')
app.mount('/human_in_the_loop', human_in_the_loop_app, 'Human in the Loop')
app.mount(
    '/predictive_state_updates',
    predictive_state_updates_app,
    'Predictive State Updates',
)
app.mount('/shared_state', shared_state_app, 'Shared State')
app.mount(
    '/tool_based_generative_ui',
    tool_based_generative_ui_app,
    'Tool Based Generative UI',
)


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "9000"))
    uvicorn.run(app, host="0.0.0.0", port=port)

if __name__ == "__main__":
    main()

__all__ = ["main"]
