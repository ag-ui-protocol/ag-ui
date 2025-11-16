"""FastAPI endpoint utilities for AWS Strands integration."""

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import RunAgentInput
from ag_ui.encoder import EventEncoder
from .agent import StrandsAgent

def add_strands_fastapi_endpoint(
    app: FastAPI,
    agent: StrandsAgent,
    path: str,
    **kwargs
) -> None:
    """Add a Strands agent endpoint to FastAPI app."""
    
    @app.post(path)
    async def strands_endpoint(input_data: RunAgentInput, request: Request):
        """AWS Strands agent endpoint."""
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