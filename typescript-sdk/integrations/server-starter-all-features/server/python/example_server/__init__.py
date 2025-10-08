"""
Example server for the AG-UI protocol.
"""

import os
import uvicorn
from fastapi import FastAPI
from .agentic_chat import agentic_chat_endpoint
from .human_in_the_loop import human_in_the_loop_endpoint
from .agentic_generative_ui import agentic_generative_ui_endpoint
from .tool_based_generative_ui import tool_based_generative_ui_endpoint
from .shared_state import shared_state_endpoint
from .predictive_state_updates import predictive_state_updates_endpoint

app = FastAPI(title="AG-UI Endpoint")

# Register the agentic chat endpoint
app.post("/agentic_chat")(agentic_chat_endpoint)

# Register the human in the loop endpoint
app.post("/human_in_the_loop")(human_in_the_loop_endpoint)

# Register the agentic generative UI endpoint
app.post("/agentic_generative_ui")(agentic_generative_ui_endpoint)

# Register the tool-based generative UI endpoint
app.post("/tool_based_generative_ui")(tool_based_generative_ui_endpoint)

# Register the shared state endpoint
app.post("/shared_state")(shared_state_endpoint)

# Register the predictive state updates endpoint
app.post("/predictive_state_updates")(predictive_state_updates_endpoint)


def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "example_server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )
