#!/usr/bin/env python
"""Complete setup example for ADK middleware with AG-UI."""

import logging

import asyncio
import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Set up basic logging format
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Configure component-specific logging levels using standard Python logging
# Can be overridden with PYTHONPATH or programmatically
logging.getLogger('adk_agent').setLevel(logging.WARNING)
logging.getLogger('event_translator').setLevel(logging.WARNING)
logging.getLogger('endpoint').setLevel(logging.WARNING)  
logging.getLogger('session_manager').setLevel(logging.WARNING)
logging.getLogger('agent_registry').setLevel(logging.WARNING)  

# from adk_agent import ADKAgent
# from agent_registry import AgentRegistry
# from endpoint import add_adk_fastapi_endpoint
from adk_middleware import ADKAgent, AgentRegistry, add_adk_fastapi_endpoint
# Import Google ADK components
from google.adk.agents import Agent
from google.adk import tools as adk_tools
import os

# Ensure session_manager logger is set to DEBUG after import
logging.getLogger('adk_middleware.session_manager').setLevel(logging.DEBUG)
# Also explicitly set adk_agent logger to DEBUG
logging.getLogger('adk_middleware.adk_agent').setLevel(logging.DEBUG)


async def setup_and_run():
    """Complete setup and run the server."""
    
    # Step 1: Configure Google ADK authentication
    # Google ADK uses environment variables for authentication:
    # export GOOGLE_API_KEY="your-api-key-here"
    # 
    # Or use Application Default Credentials (ADC):
    # gcloud auth application-default login
    
    # The API key will be automatically picked up from the environment
    
    
    # Step 2: Create shared memory service
    print("🧠 Creating shared memory service...")
    from google.adk.memory import InMemoryMemoryService
    shared_memory_service = InMemoryMemoryService()
    
    # Step 3: Create your ADK agent(s)
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
        
        Always be friendly and professional.""",
        tools=[adk_tools.preload_memory_tool.PreloadMemoryTool()]
    )
    
    # Step 3: Register agents
    print("📝 Registering agents...")
    registry = AgentRegistry.get_instance()
    
    # Register with specific IDs that AG-UI clients can reference
    registry.register_agent("assistant", assistant)
    
    # Try to import and register haiku generator agent
    print("🎋 Attempting to import haiku generator agent...")
    try:
        from tool_based_generative_ui.agent import haiku_generator_agent
        print(f"   ✅ Successfully imported haiku_generator_agent")
        print(f"   Type: {type(haiku_generator_agent)}")
        print(f"   Name: {getattr(haiku_generator_agent, 'name', 'NO NAME')}")
        registry.register_agent('adk-tool-based-generative-ui', haiku_generator_agent)
        print(f"   ✅ Registered as 'adk-tool-based-generative-ui'")
    except Exception as e:
        print(f"   ❌ Failed to import haiku_generator_agent: {e}")
    
    # Set default agent
    registry.set_default_agent(assistant)
    
    # List all registered agents
    print("\n📋 Currently registered agents:")
    for agent_id in registry.list_registered_agents():
        print(f"   - {agent_id}")
    
    
    # Step 4: Configure ADK middleware
    print("⚙️ Configuring ADK middleware...")
    
    # Option A: Static app name and user ID (simple testing)
    # adk_agent = ADKAgent(
    #     app_name="demo_app",
    #     user_id="demo_user",
    #     use_in_memory_services=True
    # )
    
    # Option B: Dynamic extraction from context (recommended)
    def extract_user_id(input_data):
        """Extract user ID from context."""
        for ctx in input_data.context:
            if ctx.description == "user":
                return ctx.value
        return "test_user"  # Static user ID for memory testing
    
    def extract_app_name(input_data):
        """Extract app name from context."""
        for ctx in input_data.context:
            if ctx.description == "app":
                return ctx.value
        return "default_app"
    
    adk_agent = ADKAgent(
        app_name_extractor=extract_app_name,
        user_id_extractor=extract_user_id,
        use_in_memory_services=True,
        memory_service=shared_memory_service,  # Use the same memory service as the ADK agent
        # Defaults: 1200s timeout (20 min), 300s cleanup (5 min)
    )
    
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
    
    # Add haiku generator endpoint
    add_adk_fastapi_endpoint(app, adk_agent, path="/adk-tool-based-generative-ui")
    print("   ✅ Added endpoint: /adk-tool-based-generative-ui")
    
    # Agent-specific endpoints (optional)
    # This allows clients to specify which agent to use via the URL
    # add_adk_fastapi_endpoint(app, adk_agent, path="/agents/assistant")
    # add_adk_fastapi_endpoint(app, adk_agent, path="/agents/code-helper")
    
    @app.get("/")
    async def root():
        registry = AgentRegistry.get_instance()
        return {
            "service": "ADK-AG-UI Integration",
            "version": "0.1.0",
            "agents": {
                "default": "assistant",
                "available": registry.list_registered_agents()
            },
            "endpoints": {
                "chat": "/chat",
                "adk-tool-based-generative-ui": "/adk-tool-based-generative-ui",
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
    print("🏥 Health check: http://localhost:8000/health")
    print("\n🔧 Logging Control:")
    print("   # Set logging level for specific components:")
    print("   logging.getLogger('event_translator').setLevel(logging.DEBUG)")
    print("   logging.getLogger('endpoint').setLevel(logging.DEBUG)")
    print("   logging.getLogger('session_manager').setLevel(logging.DEBUG)")
    print("\n🧪 Test with curl:")
    print('curl -X POST http://localhost:8000/chat \\')
    print('  -H "Content-Type: application/json" \\')
    print('  -H "Accept: text/event-stream" \\')
    print('  -d \'{')
    print('    "thread_id": "test-123",')
    print('    "run_id": "run-456",')
    print('    "messages": [{"role": "user", "content": "Hello! What can you do?"}],')
    print('    "context": [')
    print('      {"description": "user", "value": "john_doe"},')
    print('      {"description": "app", "value": "my_app_v1"}')
    print('    ]')
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