#!/usr/bin/env python

"""Example FastAPI server using ADK middleware.

This example shows how to use the ADK middleware with FastAPI.
Note: Requires google.adk to be installed and configured.
"""

import logging
import uvicorn
from fastapi import FastAPI

# Set up logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Also ensure the adk_middleware loggers are set to DEBUG level for comprehensive logging
logging.getLogger('adk_middleware').setLevel(logging.DEBUG)
logging.getLogger('adk_middleware.endpoint').setLevel(logging.DEBUG)
logging.getLogger('adk_middleware.adk_agent').setLevel(logging.DEBUG)
logging.getLogger('adk_middleware.agent_registry').setLevel(logging.DEBUG)

print("DEBUG: Starting FastAPI server imports...")

try:
    from tool_based_generative_ui.agent import haiku_generator_agent
    print("DEBUG: Successfully imported haiku_generator_agent")
except Exception as e:
    print(f"DEBUG: ERROR importing haiku_generator_agent: {e}")
    print("DEBUG: Setting haiku_generator_agent to None")
    haiku_generator_agent = None

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
    print("DEBUG: Registering default agent...")
    registry.set_default_agent(sample_agent)
    
    if haiku_generator_agent is not None:
        print("DEBUG: Attempting to register haiku_generator_agent...")
        print(f"DEBUG: haiku_generator_agent type: {type(haiku_generator_agent)}")
        print(f"DEBUG: haiku_generator_agent name: {getattr(haiku_generator_agent, 'name', 'NO NAME')}")
        print(f"DEBUG: haiku_generator_agent has tools: {hasattr(haiku_generator_agent, 'tools')}")
        if hasattr(haiku_generator_agent, 'tools'):
            print(f"DEBUG: haiku_generator_agent tools: {haiku_generator_agent.tools}")
        registry.register_agent('adk-tool-based-generative-ui', haiku_generator_agent)
        print("DEBUG: Successfully registered haiku_generator_agent")
    else:
        print("DEBUG: WARNING - haiku_generator_agent is None, skipping registration")
    
    # Verify registration
    print("\nDEBUG: Listing all registered agents:")
    for agent_id in registry.list_registered_agents():
        print(f"  - {agent_id}")
    
    print("\nDEBUG: Testing agent retrieval:")
    try:
        test_agent = registry.get_agent('adk-tool-based-generative-ui')
        print(f"  - Successfully retrieved agent: {test_agent}")
    except Exception as e:
        print(f"  - ERROR retrieving agent: {e}")
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
    
    # Create FastAPI app
    app = FastAPI(title="ADK Middleware Demo")
    
    # Add the ADK endpoint
    add_adk_fastapi_endpoint(app, adk_agent, path="/chat")
    add_adk_fastapi_endpoint(app, adk_agent_haiku_generator, path="/adk-tool-based-generative-ui")
    
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