#!/usr/bin/env python
"""Basic test to verify ADK setup works."""

import os

try:
    # Test imports
    print("Testing imports...")
    from google.adk.agents import Agent
    from google.adk import Runner
    print("✅ Google ADK imports successful")
    
    from adk_agent import ADKAgent
    from agent_registry import AgentRegistry
    print("✅ ADK middleware imports successful")
    
    # Test agent creation
    print("\nTesting agent creation...")
    agent = Agent(
        name="test_agent",
        instruction="You are a test agent."
    )
    print(f"✅ Created agent: {agent.name}")
    
    # Test registry
    print("\nTesting registry...")
    registry = AgentRegistry.get_instance()
    registry.set_default_agent(agent)
    retrieved = registry.get_agent("test")  # Should return default agent
    print(f"✅ Registry working: {retrieved.name}")
    
    # Test ADK middleware
    print("\nTesting ADK middleware...")
    adk_agent = ADKAgent(
        app_name="test_app",
        user_id="test",
        use_in_memory_services=True,
    )
    print("✅ ADK middleware created")
    
    print("\n🎉 All basic tests passed!")
    print("\nNext steps:")
    print("1. Set GOOGLE_API_KEY environment variable")
    print("2. Run: python examples/complete_setup.py")
    
except ImportError as e:
    print(f"❌ Import error: {e}")
    print("\nMake sure you have:")
    print("1. Activated the virtual environment: source venv/bin/activate")
    print("2. Installed dependencies: pip install -e .")
    print("3. Installed google-adk: pip install google-adk")
    
except Exception as e:
    print(f"❌ Error: {e}")
    import traceback
    traceback.print_exc()