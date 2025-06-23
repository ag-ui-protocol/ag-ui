import os
import uvicorn
from fastapi import FastAPI

from .endpoint import add_crewai_fastapi_endpoint
from .examples.agentic_chat import AgenticChatFlow
from .examples.human_in_the_loop import HumanInTheLoopFlow
from .examples.tool_based_generative_ui import ToolBasedGenerativeUIFlow
from .examples.agentic_generative_ui import AgenticGenerativeUIFlow
from .examples.shared_state import SharedStateFlow
from .examples.predictive_state_updates import PredictiveStateUpdatesFlow

app = FastAPI(title="CrewAI Dojo Example Server")

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=AgenticChatFlow,
    path="/agentic_chat",
)

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=HumanInTheLoopFlow,
    path="/human_in_the_loop",
)

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=ToolBasedGenerativeUIFlow,
    path="/tool_based_generative_ui",
)

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=AgenticGenerativeUIFlow,
    path="/agentic_generative_ui",
)

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=SharedStateFlow,
    path="/shared_state",
)

add_crewai_fastapi_endpoint(
    app=app,
    flow_class=PredictiveStateUpdatesFlow,
    path="/predictive_state_updates",
)

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "agui_crewai.dojo:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )
