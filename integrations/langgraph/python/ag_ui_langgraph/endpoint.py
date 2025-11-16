from fastapi import FastAPI, Request, APIRouter
from fastapi.responses import StreamingResponse

from ag_ui.core.types import RunAgentInput
from ag_ui.encoder import EventEncoder

from .agent import LangGraphAgent


def add_langgraph_fastapi_endpoints(
    app: FastAPI, agent: LangGraphAgent, path: str = "/"
):
    """Adds endpoints to the FastAPI app."""

    router = APIRouter(prefix=path.rstrip("/"))

    @router.post("/")
    async def langgraph_agent_endpoint(input_data: RunAgentInput, request: Request):
        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        async def event_generator():
            async for event in agent.run(input_data):
                yield encoder.encode(event)

        return StreamingResponse(
            event_generator(), media_type=encoder.get_content_type()
        )

    @router.get("/health")
    def health():
        """Health check."""
        return {
            "status": "ok",
            "agent": {
                "name": agent.name,
            },
        }

    app.include_router(router)
