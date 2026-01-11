"""FastAPI endpoint utilities for Langroid integration."""

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from .agent import LangroidAgent


def add_langroid_fastapi_endpoint(
    app: FastAPI,
    agent: LangroidAgent,
    path: str,
    **kwargs
) -> None:
    """Add a Langroid agent endpoint to FastAPI app."""
    
    @app.post(path)
    async def langroid_endpoint(input_data: RunAgentInput, request: Request):
        """Langroid agent endpoint."""
        accept_header = request.headers.get("accept")
        encoder = EventEncoder(accept=accept_header)
        
        async def event_generator():
            async for event in agent.run(input_data):
                try:
                    yield encoder.encode(event)
                except Exception as e:
                    from ag_ui.core import RunErrorEvent, EventType
                    error_event = RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"Encoding error: {str(e)}",
                        code="ENCODING_ERROR"
                    )
                    yield encoder.encode(error_event)
                    break
        
        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        )

    @app.get(f"{path}/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": agent.name,
                "description": agent.description,
            }
        }


def create_langroid_app(agent: LangroidAgent, path: str = "/") -> FastAPI:
    """Create a FastAPI app with a single Langroid agent endpoint."""
    app = FastAPI(title=f"Langroid - {agent.name}")
    
    # Add CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Add the agent endpoint
    add_langroid_fastapi_endpoint(app, agent, path)
    
    return app

