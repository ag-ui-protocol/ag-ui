#!/usr/bin/env python

"""Example FastAPI server using ADK middleware.

This example shows how to use the ADK middleware with FastAPI.
Note: Requires google.adk to be installed and configured.
"""

import uvicorn
from fastapi import FastAPI
from tool_based_generative_ui.agent import haiku_generator_agent
from human_in_the_loop.agent import human_in_loop_agent

# These imports will work once google.adk is available
try:
    # from src.adk_agent import ADKAgent
    # from src.agent_registry import AgentRegistry
    # from src.endpoint import add_adk_fastapi_endpoint

    from adk_middleware import ADKAgent, AgentRegistry, add_adk_fastapi_endpoint
    from google.adk.agents import LlmAgent
    
    # Set up the agent registry
    registry = AgentRegistry.get_instance()
    
    # Create a sample ADK agent (this would be your actual agent)
    sample_agent = LlmAgent(
        name="assistant",
        model="gemini-2.0-flash",
        instruction="You are a helpful assistant."
    )
    
    # Register the agent
    registry.set_default_agent(sample_agent)
    registry.register_agent('adk-tool-based-generative-ui', haiku_generator_agent)
    registry.register_agent('adk-human-in-loop-agent', human_in_loop_agent)
    # Create ADK middleware agent
    adk_agent = ADKAgent(
        app_name="demo_app",
        user_id="demo_user",
        session_timeout_seconds=3600,
        use_in_memory_services=True
    )
    
    adk_agent_haiku_generator = ADKAgent(
        app_name="demo_app",
        user_id="demo_user",
        session_timeout_seconds=3600,
        use_in_memory_services=True
    )
    
    adk_human_in_loop_agent = ADKAgent(
        app_name="demo_app",
        user_id="demo_user",
        session_timeout_seconds=3600,
        use_in_memory_services=True
    )
    
    # Create FastAPI app
    app = FastAPI(title="ADK Middleware Demo")
    
    # Add the ADK endpoint
    add_adk_fastapi_endpoint(app, adk_agent, path="/chat")
    add_adk_fastapi_endpoint(app, adk_agent_haiku_generator, path="/adk-tool-based-generative-ui")
    add_adk_fastapi_endpoint(app, adk_human_in_loop_agent, path="/adk-human-in-loop-agent")
    
    @app.get("/")
    async def root():
        return {"message": "ADK Middleware is running!", "endpoint": "/chat"}
    
    if __name__ == "__main__":
        print("Starting ADK Middleware server...")
        print("Chat endpoint available at: http://localhost:8000/chat")
        print("API docs available at: http://localhost:8000/docs")
        uvicorn.run(app, host="0.0.0.0", port=8000)
        
except ImportError as e:
    print(f"Cannot run server: {e}")
    print("Please install google.adk and ensure all dependencies are available.")
    print("\nTo install dependencies:")
    print("  pip install google-adk")
    print("  # Note: google-adk may not be publicly available yet")