# src/endpoint.py

"""FastAPI endpoint for ADK middleware."""

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from adk_agent import ADKAgent


def add_adk_fastapi_endpoint(app: FastAPI, agent: ADKAgent, path: str = "/"):
    """Add ADK middleware endpoint to FastAPI app.
    
    Args:
        app: FastAPI application instance
        agent: Configured ADKAgent instance
        path: API endpoint path
    """
    
    @app.post(path)
    async def adk_endpoint(input_data: RunAgentInput, request: Request):
        """ADK middleware endpoint."""
        
        # Get the accept header from the request
        accept_header = request.headers.get("accept")
        
        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)
        
        async def event_generator():
            """Generate events from ADK agent."""
            try:
                async for event in agent.run(input_data):
                    yield encoder.encode(event)
            except Exception as e:
                # Let the ADKAgent handle errors - it should emit RunErrorEvent
                # If it doesn't, this will just close the stream
                pass
        
        return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


def create_adk_app(agent: ADKAgent, path: str = "/") -> FastAPI:
    """Create a FastAPI app with ADK middleware endpoint.
    
    Args:
        agent: Configured ADKAgent instance  
        path: API endpoint path
        
    Returns:
        FastAPI application instance
    """
    app = FastAPI(title="ADK Middleware for AG-UI Protocol")
    add_adk_fastapi_endpoint(app, agent, path)
    return app