"""Utility functions for AWS Strands integration."""

from fastapi import FastAPI
from .agent import StrandsAgent
from .endpoint import add_strands_fastapi_endpoint

def create_strands_app(agent: StrandsAgent, path: str = "/") -> FastAPI:
    """Create a FastAPI app with a single Strands agent endpoint."""
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
    
    return app