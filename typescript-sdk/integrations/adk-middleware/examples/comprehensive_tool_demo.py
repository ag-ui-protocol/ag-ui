#!/usr/bin/env python
"""Comprehensive demonstration of ADK middleware tool support.

This example demonstrates the complete tool support feature including:
- Basic calculator tool usage
- Multi-tool scenarios with different tool types
- Concurrent tool execution
- Proper error handling and timeouts
- Asynchronous communication patterns

The implementation properly handles the asynchronous nature of tool execution
by separating the agent execution from tool result handling using concurrent
tasks and async communication channels.

Prerequisites:
- Set GOOGLE_API_KEY environment variable
- Install dependencies: pip install -e .

Run with: 
    GOOGLE_API_KEY=your-key python examples/comprehensive_tool_demo.py

Key Architecture:
- Agent execution runs in background asyncio task
- Tool handler runs in separate concurrent task  
- Communication via asyncio.Queue for tool call information
- Tool results delivered via ExecutionState.resolve_tool_result()
- Proper cleanup and timeout handling throughout
"""

import asyncio
import json
import os
import time
from typing import Dict, Any, List
from adk_middleware import ADKAgent, AgentRegistry
from google.adk.agents import LlmAgent
from ag_ui.core import RunAgentInput, UserMessage, ToolMessage, Tool as AGUITool


def create_calculator_tool() -> AGUITool:
    """Create a mathematical calculator tool.
    
    Returns:
        AGUITool configured for basic arithmetic operations
    """
    return AGUITool(
        name="calculator",
        description="Perform basic mathematical calculations including add, subtract, multiply, and divide",
        parameters={
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": ["add", "subtract", "multiply", "divide"],
                    "description": "The mathematical operation to perform"
                },
                "a": {"type": "number", "description": "First number"},
                "b": {"type": "number", "description": "Second number"}
            },
            "required": ["operation", "a", "b"]
        }
    )


def create_weather_tool() -> AGUITool:
    """Create a weather information tool.
    
    Returns:
        AGUITool configured for weather data retrieval
    """
    return AGUITool(
        name="get_weather",
        description="Get current weather information for a specific location",
        parameters={
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "The city and state/country for weather lookup"
                },
                "units": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                    "description": "Temperature units to use",
                    "default": "celsius"
                }
            },
            "required": ["location"]
        }
    )


def create_time_tool() -> AGUITool:
    """Create a current time tool.
    
    Returns:
        AGUITool configured for time information
    """
    return AGUITool(
        name="get_current_time",
        description="Get the current date and time",
        parameters={
            "type": "object",
            "properties": {
                "timezone": {
                    "type": "string",
                    "description": "Timezone identifier (e.g., 'UTC', 'US/Eastern')",
                    "default": "UTC"
                },
                "format": {
                    "type": "string",
                    "enum": ["iso", "human"],
                    "description": "Output format for the time",
                    "default": "human"
                }
            },
            "required": []
        }
    )


def simulate_calculator_execution(args: Dict[str, Any]) -> Dict[str, Any]:
    """Simulate calculator tool execution with proper error handling.
    
    Args:
        args: Tool arguments containing operation, a, and b
        
    Returns:
        Dict containing result or error information
    """
    operation = args.get("operation")
    a = args.get("a", 0)
    b = args.get("b", 0)
    
    print(f"   🧮 Computing {a} {operation} {b}")
    
    try:
        if operation == "add":
            result = a + b
        elif operation == "subtract":
            result = a - b
        elif operation == "multiply":
            result = a * b
        elif operation == "divide":
            if b == 0:
                return {
                    "error": "Division by zero is not allowed",
                    "error_type": "mathematical_error"
                }
            result = a / b
        else:
            return {
                "error": f"Unknown operation: {operation}",
                "error_type": "invalid_operation"
            }
        
        return {
            "result": result,
            "calculation": f"{a} {operation} {b} = {result}",
            "operation_type": operation
        }
        
    except Exception as e:
        return {
            "error": f"Calculation failed: {str(e)}",
            "error_type": "execution_error"
        }


def simulate_weather_execution(args: Dict[str, Any]) -> Dict[str, Any]:
    """Simulate weather tool execution with realistic data.
    
    Args:
        args: Tool arguments containing location and units
        
    Returns:
        Dict containing weather information or error
    """
    location = args.get("location", "Unknown")
    units = args.get("units", "celsius")
    
    print(f"   🌤️  Fetching weather for {location} in {units}")
    
    # Simulate network delay
    time.sleep(0.5)
    
    # Mock weather data based on location
    weather_data = {
        "new york": {"temp": 22 if units == "celsius" else 72, "condition": "Partly cloudy", "humidity": 65},
        "london": {"temp": 15 if units == "celsius" else 59, "condition": "Rainy", "humidity": 80},
        "tokyo": {"temp": 28 if units == "celsius" else 82, "condition": "Sunny", "humidity": 55},
        "sydney": {"temp": 25 if units == "celsius" else 77, "condition": "Clear", "humidity": 60}
    }
    
    location_key = location.lower()
    for key in weather_data:
        if key in location_key:
            data = weather_data[key]
            return {
                "location": location,
                "temperature": data["temp"],
                "units": units,
                "condition": data["condition"],
                "humidity": data["humidity"],
                "last_updated": "2024-01-15 14:30:00"
            }
    
    # Default weather for unknown locations
    return {
        "location": location,
        "temperature": 20 if units == "celsius" else 68,
        "units": units,
        "condition": "Unknown",
        "humidity": 50,
        "note": f"Weather data not available for {location}, showing default values"
    }


def simulate_time_execution(args: Dict[str, Any]) -> Dict[str, Any]:
    """Simulate time tool execution.
    
    Args:
        args: Tool arguments containing timezone and format
        
    Returns:
        Dict containing current time information
    """
    timezone = args.get("timezone", "UTC")
    format_type = args.get("format", "human")
    
    print(f"   🕒 Getting current time for {timezone} in {format_type} format")
    
    import datetime
    
    # For demo purposes, use current time
    now = datetime.datetime.now()
    
    if format_type == "iso":
        time_str = now.isoformat()
    else:
        time_str = now.strftime("%Y-%m-%d %H:%M:%S")
    
    return {
        "current_time": time_str,
        "timezone": timezone,
        "format": format_type,
        "timestamp": now.timestamp(),
        "day_of_week": now.strftime("%A")
    }


async def tool_handler_task(adk_agent: ADKAgent, tool_events: asyncio.Queue):
    """Handle tool execution requests asynchronously.
    
    This task receives tool call information via the queue and executes
    the appropriate simulation function, then delivers results back to 
    the waiting agent execution via the ExecutionState.
    
    Args:
        adk_agent: The ADK agent instance containing active executions
        tool_events: Queue for receiving tool call information
    """
    print("🔧 Tool handler started - ready to process tool calls")
    
    tool_handlers = {
        "calculator": simulate_calculator_execution,
        "get_weather": simulate_weather_execution,
        "get_current_time": simulate_time_execution
    }
    
    while True:
        try:
            # Wait for tool call information
            tool_info = await tool_events.get()
            
            if tool_info is None:  # Shutdown signal
                print("🔧 Tool handler received shutdown signal")
                break
            
            tool_call_id = tool_info["tool_call_id"]
            tool_name = tool_info["tool_name"]
            args = tool_info["args"]
            
            print(f"\n🔧 Processing tool call: {tool_name}")
            print(f"   📋 ID: {tool_call_id}")
            print(f"   📋 Arguments: {json.dumps(args, indent=2)}")
            
            # Execute the appropriate tool handler
            if tool_name in tool_handlers:
                print(f"   ⚙️  Executing {tool_name}...")
                start_time = time.time()
                
                result = tool_handlers[tool_name](args)
                
                execution_time = time.time() - start_time
                print(f"   ✅ Execution completed in {execution_time:.2f}s")
                print(f"   📤 Result: {json.dumps(result, indent=2)}")
            else:
                print(f"   ❌ Unknown tool: {tool_name}")
                result = {
                    "error": f"Tool '{tool_name}' is not implemented",
                    "error_type": "unknown_tool",
                    "available_tools": list(tool_handlers.keys())
                }
            
            # Find the execution and resolve the tool future
            async with adk_agent._execution_lock:
                delivered = False
                for thread_id, execution in adk_agent._active_executions.items():
                    if tool_call_id in execution.tool_futures:
                        # Resolve the future with the result
                        success = execution.resolve_tool_result(tool_call_id, result)
                        if success:
                            print(f"   ✅ Result delivered to execution {thread_id}")
                            delivered = True
                        else:
                            print(f"   ❌ Failed to deliver result to execution {thread_id}")
                        break
                
                if not delivered:
                    print(f"   ⚠️  No active execution found for tool call {tool_call_id}")
            
        except Exception as e:
            print(f"❌ Error in tool handler: {e}")
            import traceback
            traceback.print_exc()


async def agent_execution_task(adk_agent: ADKAgent, user_input: RunAgentInput, tool_events: asyncio.Queue):
    """Run the agent and collect tool call events.
    
    This task runs the agent execution in the background and forwards 
    tool call information to the tool handler task via the queue.
    
    Args:
        adk_agent: The ADK agent instance
        user_input: The user's input for this execution
        tool_events: Queue for sending tool call information to handler
    """
    print("🚀 Agent execution started - processing user request")
    
    current_tool_call = {}
    event_count = 0
    
    try:
        async for event in adk_agent.run(user_input):
            event_count += 1
            event_type = event.type.value if hasattr(event.type, 'value') else str(event.type)
            
            # Only print significant events to avoid spam
            if event_type in ["RUN_STARTED", "RUN_FINISHED", "RUN_ERROR", "TEXT_MESSAGE_START", "TEXT_MESSAGE_END", "TOOL_CALL_START", "TOOL_CALL_END"]:
                print(f"📨 Event #{event_count}: {event_type}")
            
            if event_type == "RUN_STARTED":
                print("   🚀 Agent run started - beginning processing")
            elif event_type == "RUN_FINISHED":
                print("   ✅ Agent run finished successfully")
            elif event_type == "RUN_ERROR":
                print(f"   ❌ Agent error: {event.message}")
            elif event_type == "TEXT_MESSAGE_START":
                print("   💬 Assistant response starting...")
            elif event_type == "TEXT_MESSAGE_CONTENT":
                # Print content without newlines for better formatting
                print(f"💬 {event.delta}", end="", flush=True)
            elif event_type == "TEXT_MESSAGE_END":
                print("\n   💬 Assistant response complete")
            elif event_type == "TOOL_CALL_START":
                # Start collecting tool call info
                current_tool_call = {
                    "tool_call_id": event.tool_call_id,
                    "tool_name": event.tool_call_name,
                }
                print(f"   🔧 Tool call started: {event.tool_call_name} (ID: {event.tool_call_id})")
            elif event_type == "TOOL_CALL_ARGS":
                # Add arguments to current tool call
                current_tool_call["args"] = json.loads(event.delta)
                print(f"   📋 Tool arguments received")
            elif event_type == "TOOL_CALL_END":
                # Send complete tool call info to handler
                print(f"   🏁 Tool call ended: {event.tool_call_id}")
                if current_tool_call.get("tool_call_id") == event.tool_call_id:
                    await tool_events.put(current_tool_call.copy())
                    print(f"   📤 Tool call info sent to handler")
                    current_tool_call.clear()
    
    except Exception as e:
        print(f"❌ Error in agent execution: {e}")
        import traceback
        traceback.print_exc()
    finally:
        # Signal tool handler to shutdown
        await tool_events.put(None)
        print("🚀 Agent execution completed - shutdown signal sent")


async def run_demo_scenario(
    adk_agent: ADKAgent, 
    scenario_name: str, 
    user_message: str, 
    tools: List[AGUITool],
    thread_id: str = None
):
    """Run a single demo scenario with proper setup and cleanup.
    
    Args:
        adk_agent: The ADK agent instance
        scenario_name: Name of the scenario for logging
        user_message: The user's message/request
        tools: List of tools available for this scenario
        thread_id: Optional thread ID (generates one if not provided)
    """
    if thread_id is None:
        thread_id = f"demo_thread_{int(time.time())}"
    
    print(f"\n{'='*80}")
    print(f"🎯 SCENARIO: {scenario_name}")
    print(f"{'='*80}")
    print(f"👤 User: {user_message}")
    print(f"🔧 Available tools: {[tool.name for tool in tools]}")
    print(f"🧵 Thread ID: {thread_id}")
    print(f"{'='*80}")
    
    # Prepare input
    user_input = RunAgentInput(
        thread_id=thread_id,
        run_id=f"run_{int(time.time())}",
        messages=[UserMessage(id="1", role="user", content=user_message)],
        tools=tools,
        context=[],
        state={},
        forwarded_props={}
    )
    
    # Create communication channel
    tool_events = asyncio.Queue()
    
    # Run both tasks concurrently
    try:
        start_time = time.time()
        
        agent_task = asyncio.create_task(
            agent_execution_task(adk_agent, user_input, tool_events)
        )
        tool_task = asyncio.create_task(
            tool_handler_task(adk_agent, tool_events)
        )
        
        # Wait for both to complete
        await asyncio.gather(agent_task, tool_task)
        
        execution_time = time.time() - start_time
        print(f"\n✅ Scenario '{scenario_name}' completed in {execution_time:.2f}s")
        
    except Exception as e:
        print(f"❌ Error in scenario '{scenario_name}': {e}")
        import traceback
        traceback.print_exc()


async def main():
    """Main function demonstrating comprehensive tool usage scenarios."""
    
    # Check for API key
    if not os.getenv("GOOGLE_API_KEY"):
        print("❌ Please set GOOGLE_API_KEY environment variable")
        print("   Get a free key at: https://makersuite.google.com/app/apikey")
        print("\n   Example:")
        print("   export GOOGLE_API_KEY='your-api-key-here'")
        print("   python examples/comprehensive_tool_demo.py")
        return
    
    print("🚀 Comprehensive ADK Middleware Tool Demo")
    print("=" * 80)
    print("This demo showcases the complete tool support implementation including:")
    print("• Basic single tool usage (calculator)")
    print("• Multi-tool scenarios with different tool types")
    print("• Concurrent tool execution capabilities")
    print("• Proper error handling and timeout management")
    print("• Asynchronous communication patterns")
    print()
    print("Architecture highlights:")
    print("• Agent execution runs in background asyncio task")
    print("• Tool handler processes requests in separate concurrent task")
    print("• Communication via asyncio.Queue prevents deadlocks")
    print("• Tool results delivered via ExecutionState.resolve_tool_result()")
    print("=" * 80)
    
    # Setup ADK agent and middleware
    print("📋 Setting up ADK agent and middleware...")
    
    agent = LlmAgent(
        name="comprehensive_demo_agent",
        model="gemini-2.0-flash",
        instruction="""You are a helpful assistant with access to multiple tools. 
        Use the available tools to help answer questions and perform tasks.
        Always use tools when appropriate rather than making up information.
        Be conversational and explain what you're doing with the tools."""
    )
    
    registry = AgentRegistry.get_instance()
    registry.set_default_agent(agent)
    
    adk_agent = ADKAgent(
        user_id="demo_user",
        tool_timeout_seconds=30,
        execution_timeout_seconds=120
    )
    
    # Create all available tools
    calculator_tool = create_calculator_tool()
    weather_tool = create_weather_tool()
    time_tool = create_time_tool()
    
    try:
        # Scenario 1: Basic single tool usage
        await run_demo_scenario(
            adk_agent=adk_agent,
            scenario_name="Basic Calculator Usage",
            user_message="What is 25 multiplied by 4? Please show your work.",
            tools=[calculator_tool],
            thread_id="basic_calc_demo"
        )
        
        # Brief pause between scenarios
        await asyncio.sleep(2)
        
        # Scenario 2: Multi-tool scenario
        await run_demo_scenario(
            adk_agent=adk_agent,
            scenario_name="Multi-Tool Information Gathering",
            user_message="What's the weather like in Tokyo and what time is it right now?",
            tools=[weather_tool, time_tool],
            thread_id="multi_tool_demo"
        )
        
        # Brief pause between scenarios
        await asyncio.sleep(2)
        
        # Scenario 3: Complex calculation with multiple operations
        await run_demo_scenario(
            adk_agent=adk_agent,
            scenario_name="Complex Multi-Step Calculations",
            user_message="I need to calculate the area of a rectangle that is 15.5 meters by 8.2 meters, then find what 25% of that area would be.",
            tools=[calculator_tool],
            thread_id="complex_calc_demo"
        )
        
        # Brief pause between scenarios
        await asyncio.sleep(2)
        
        # Scenario 4: All tools available - let the agent choose
        await run_demo_scenario(
            adk_agent=adk_agent,
            scenario_name="All Tools Available - Agent Choice",
            user_message="I'm planning a trip to London. Can you tell me what the weather is like there, what time it is now, and help me calculate how much I'll spend if I budget $150 per day for 7 days?",
            tools=[calculator_tool, weather_tool, time_tool],
            thread_id="all_tools_demo"
        )
        
    except Exception as e:
        print(f"❌ Error during demo execution: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        # Clean up
        await adk_agent.close()
    
    # Final summary
    print("\n" + "=" * 80)
    print("✅ Comprehensive Tool Demo Completed Successfully!")
    print("=" * 80)
    print()
    print("🎯 What was demonstrated:")
    print("  • Single tool execution with proper event handling")
    print("  • Multi-tool scenarios with different tool types")
    print("  • Complex multi-step operations requiring multiple tool calls")
    print("  • Agent autonomy in tool selection from available options")
    print("  • Asynchronous communication preventing deadlocks")
    print("  • Proper timeout and error handling throughout")
    print()
    print("💡 Key implementation insights:")
    print("  • Background agent execution via asyncio tasks")
    print("  • Separate tool handler for processing tool calls")
    print("  • Queue-based communication between agent and tool handler")
    print("  • ExecutionState manages tool futures and result delivery")
    print("  • ClientProxyTool bridges AG-UI tools to ADK tools")
    print("  • Event translation maintains protocol compatibility")
    print()
    print("🔧 Integration points:")
    print("  • Tools defined using AG-UI Tool schema")
    print("  • Events emitted follow AG-UI protocol specifications")
    print("  • Results delivered asynchronously via futures")
    print("  • Timeouts and cleanup handled automatically")
    print()
    print("📈 Production considerations:")
    print("  • Configure appropriate timeout values for your use case")
    print("  • Implement proper error handling in tool implementations")
    print("  • Consider rate limiting for external tool calls")
    print("  • Monitor execution metrics and performance")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())