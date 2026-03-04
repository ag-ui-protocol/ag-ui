"""Utility functions for AWS Strands integration."""

from fastapi import FastAPI
from .agent import StrandsAgent
from .endpoint import add_strands_fastapi_endpoint, add_ping

def create_strands_app(
    agent: StrandsAgent, 
    path: str = "/", 
    ping_path: str | None = "/ping"
) -> FastAPI:
    """Create a FastAPI app with a single Strands agent endpoint and optional ping endpoint.
    
    Args:
        agent: The StrandsAgent instance
        path: Path for the agent endpoint (default: "/")
        ping_path: Path for the ping endpoint (default: "/ping"). Pass None to disable.
    """
    app = FastAPI(title=f"AWS Strands - {agent.name}")
    
    # Add CORS middleware
    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Add the agent endpoint
    add_strands_fastapi_endpoint(app, agent, path)
    
    # Add ping endpoint if path is provided
    if ping_path is not None:
        add_ping(app, ping_path)
    
    return app
