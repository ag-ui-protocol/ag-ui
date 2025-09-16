"""Example usage of the ADK middleware with FastAPI.

This provides a FastAPI application that demonstrates how to use the
ADK middleware with various agent types. It includes examples for
each of the ADK middleware features:
- Basic Chat Agent
- Tool Based Generative UI
- Human in the Loop
- Shared State
- Predictive State Updates
"""

from __future__ import annotations

from fastapi import FastAPI
import uvicorn
import os


from .api import (
    basic_chat_app,
    tool_based_generative_ui_app,
    human_in_the_loop_app,
    shared_state_app,
    predictive_state_updates_app,
)

app = FastAPI(title='ADK Middleware Demo')
app.mount('/chat', basic_chat_app, 'Basic Chat')
app.mount('/adk-tool-based-generative-ui', tool_based_generative_ui_app, 'Tool Based Generative UI')
app.mount('/adk-human-in-loop-agent', human_in_the_loop_app, 'Human in the Loop')
app.mount('/adk-shared-state-agent', shared_state_app, 'Shared State')
app.mount('/adk-predictive-state-agent', predictive_state_updates_app, 'Predictive State Updates')


@app.get("/")
async def root():
    return {"message": "ADK Middleware is running!", "endpoint": "/chat"}


def main():
    """Main function to start the FastAPI server."""
    port = int(os.getenv("PORT", "8000"))
    print("Starting ADK Middleware server...")
    print(f"Chat endpoint available at: http://localhost:{port}/chat")
    print(f"API docs available at: http://localhost:{port}/docs")
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
