#!/usr/bin/env python3
"""Complete setup example for ADK middleware with AG-UI."""

import sys
import logging
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "src"))

import asyncio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Set up basic logging format
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Configure component-specific logging (can be overridden with env vars)
from logging_config import configure_logging
configure_logging(
    adk_agent='INFO',           # Keep main agent info
    event_translator='WARNING', # Quiet by default
    endpoint='WARNING',         # Quiet by default  
    raw_response='WARNING',     # Quiet by default
    llm_response='WARNING'      # Quiet by default
)

from adk_agent import ADKAgent
from agent_registry import AgentRegistry
from endpoint import add_adk_fastapi_endpoint

# Import Google ADK components
from google.adk.agents import Agent
import os


async def setup_and_run():
    """Complete setup and run the server."""
    
    # Step 1: Configure Google ADK authentication
    # Google ADK uses environment variables for authentication:
    # export GOOGLE_API_KEY="your-api-key-here"
    # 
    # Or use Application Default Credentials (ADC):
    # gcloud auth application-default login
    
    # The API key will be automatically picked up from the environment
    
    
    # Step 2: Create your ADK agent(s)
    print("🤖 Creating ADK agents...")
    
    # Create a versatile assistant
    assistant = Agent(
        name="ag_ui_assistant",
        model="gemini-2.0-flash",
        instruction="""You are a helpful AI assistant integrated with AG-UI protocol.
        
        Your capabilities:
        - Answer questions accurately and concisely
        - Help with coding and technical topics
        - Provide step-by-step explanations
        - Admit when you don't know something
        
        Always be friendly and professional."""
    )
    
    
    # Step 3: Register agents
    print("📝 Registering agents...")
    registry = AgentRegistry.get_instance()
    
    # Register with specific IDs that AG-UI clients can reference
    registry.register_agent("assistant", assistant)
    
    # Set default agent
    registry.set_default_agent(assistant)
    
    
    # Step 4: Configure ADK middleware
    print("⚙️ Configuring ADK middleware...")
    
    # Option A: Static user ID (simple testing)
    adk_agent = ADKAgent(
        app_name="demo_app",
        user_id="demo_user",
        use_in_memory_services=True
        # Uses default session manager with 20 min timeout, auto cleanup enabled
    )
    
    # Option B: Dynamic user ID extraction
    # def extract_user_id(input_data):
    #     # Extract from context, state, or headers
    #     for ctx in input_data.context:
    #         if ctx.description == "user_id":
    #             return ctx.value
    #     return f"user_{input_data.thread_id}"
    # 
    # adk_agent = ADKAgent(
    #     app_name="demo_app",
    #     user_id_extractor=extract_user_id,
    #     use_in_memory_services=True
    #     # Uses default session manager with 20 min timeout, auto cleanup enabled
    # )

    
    # Step 5: Create FastAPI app
    print("🌐 Creating FastAPI app...")
    app = FastAPI(
        title="ADK-AG-UI Integration Server",
        description="Google ADK agents exposed via AG-UI protocol"
    )
    
    # Add CORS for browser clients
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://localhost:5173"],  # Add your client URLs
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    
    # Step 6: Add endpoints
    # Main chat endpoint
    add_adk_fastapi_endpoint(app, adk_agent, path="/chat")
    
    # Agent-specific endpoints (optional)
    # This allows clients to specify which agent to use via the URL
    # add_adk_fastapi_endpoint(app, adk_agent, path="/agents/assistant")
    # add_adk_fastapi_endpoint(app, adk_agent, path="/agents/code-helper")
    
    @app.get("/")
    async def root():
        return {
            "service": "ADK-AG-UI Integration",
            "version": "0.1.0",
            "agents": {
                "default": "assistant",
                "available": ["assistant"]
            },
            "endpoints": {
                "chat": "/chat",
                "docs": "/docs",
                "health": "/health"
            }
        }
    
    @app.get("/health")
    async def health():
        registry = AgentRegistry.get_instance()
        return {
            "status": "healthy",
            "agents_registered": len(registry._agents),
            "default_agent": registry._default_agent_id
        }
    
    @app.get("/agents")
    async def list_agents():
        """List available agents."""
        registry = AgentRegistry.get_instance()
        return {
            "agents": list(registry._agents.keys()),
            "default": registry._default_agent_id
        }
    
    
    # Step 7: Run the server
    print("\n✅ Setup complete! Starting server...\n")
    print("🔗 Chat endpoint: http://localhost:8000/chat")
    print("📚 API documentation: http://localhost:8000/docs")
    print("🔍 Health check: http://localhost:8000/health")
    print("\n🔧 Logging Control:")
    print("   python configure_logging.py  # Interactive logging config")
    print("   ADK_LOG_EVENT_TRANSLATOR=DEBUG ./quickstart.sh  # Debug streaming")
    print("   ADK_LOG_ENDPOINT=DEBUG ./quickstart.sh          # Debug HTTP responses")
    print("\n🧪 Test with curl:")
    print('curl -X POST http://localhost:8000/chat \\')
    print('  -H "Content-Type: application/json" \\')
    print('  -H "Accept: text/event-stream" \\')
    print('  -d \'{')
    print('    "thread_id": "test-123",')
    print('    "run_id": "run-456",')
    print('    "messages": [{"role": "user", "content": "Hello! What can you do?"}],')
    print('    "context": []')
    print('  }\'')
    
    # Run with uvicorn
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)
    await server.serve()


if __name__ == "__main__":
    # Check for API key
    if not os.getenv("GOOGLE_API_KEY"):
        print("⚠️  Warning: GOOGLE_API_KEY environment variable not set!")
        print("   Set it with: export GOOGLE_API_KEY='your-key-here'")
        print("   Get a key from: https://makersuite.google.com/app/apikey")
        print()
    
    # Run the async setup
    asyncio.run(setup_and_run())