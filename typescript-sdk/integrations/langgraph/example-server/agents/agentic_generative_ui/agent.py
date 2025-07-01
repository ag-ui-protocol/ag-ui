"""
An example demonstrating agentic generative UI using LangGraph.
"""

import json
import asyncio
from typing import Dict, List, Any, Optional, Literal
# LangGraph imports
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command
from langchain_core.callbacks.manager import adispatch_custom_event
from langgraph.graph import MessagesState

# OpenAI imports
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage

# This tool simulates performing a task on the server.
# The tool call will be streamed to the frontend as it is being generated.
PERFORM_TASK_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_task_steps_generative_ui",
        "description": "Make up 10 steps (only a couple of words per step) that are required for a task. The step should be in gerund form (i.e. Digging hole, opening door, ...)",
        "parameters": {
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "The text of the step in gerund form"
                            },
                            "status": {
                                "type": "string",
                                "enum": ["pending"],
                                "description": "The status of the step, always 'pending'"
                            }
                        },
                        "required": ["description", "status"]
                    },
                    "description": "An array of 10 step objects, each containing text and status"
                }
            },
            "required": ["steps"]
        }
    }
}


class AgentState(MessagesState):
    steps: List[dict] = []
    tools: List[Any]


async def start_flow(state: AgentState, config: RunnableConfig):
    """
    This is the entry point for the flow.
    """

    if "steps" not in state:
        state["steps"] = []

    return Command(
        goto="chat_node",
        update={
            "messages": state["messages"],
            "steps": state["steps"]
        }
    )


async def chat_node(state: AgentState, config: RunnableConfig):
    """
    Standard chat node.
    """
    system_prompt = """
    You are a helpful assistant assisting with any task. 
    When asked to do something, you MUST call the function `generate_task_steps_generative_ui`
    that was provided to you.
    If you called the function, you MUST NOT repeat the steps in your next response to the user.
    Just give a very brief summary (one sentence) of what you did with some emojis. 
    Always say you actually did the steps, not merely generated them.
    """

    # Define the model
    model = ChatOpenAI(model="gpt-4o")
    
    # Define config for the model with emit_intermediate_state to stream tool calls to frontend
    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # Use "predict_state" metadata to set up streaming for the write_document tool
    config["metadata"]["predict_state"] = [{
        "state_key": "steps",
        "tool": "generate_task_steps_generative_ui",
        "tool_argument": "steps",
    }]

    # Bind the tools to the model
    model_with_tools = model.bind_tools(
        [
            *state["tools"],
            PERFORM_TASK_TOOL
        ],
        # Disable parallel tool calls to avoid race conditions
        parallel_tool_calls=False,
    )

    # Run the model to generate a response
    response = await model_with_tools.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)

    messages = state["messages"] + [response]

    # Extract any tool calls from the response
    if hasattr(response, "tool_calls") and response.tool_calls and len(response.tool_calls) > 0:
        tool_call = response.tool_calls[0]
        
        # Handle tool_call as a dictionary rather than an object
        if isinstance(tool_call, dict):
            tool_call_id = tool_call["id"]
            tool_call_name = tool_call["name"]
            tool_call_args = tool_call["args"]
        else:
            # Handle as an object (backward compatibility)
            tool_call_id = tool_call.id
            tool_call_name = tool_call.name
            tool_call_args = tool_call.args

        if tool_call_name == "generate_task_steps_generative_ui":
            steps = [{"description": step["description"], "status": step["status"]} for step in tool_call_args["steps"]]
            
            # Add the tool response to messages
            tool_response = {
                "role": "tool",
                "content": "Steps executed.",
                "tool_call_id": tool_call_id
            }

            messages = messages + [tool_response]

            # Return Command to route to simulate_task_node
            for i, step in enumerate(steps):
            # simulate executing the step
                await asyncio.sleep(1)
                steps[i]["status"] = "completed"
                # Update the state with the completed step - using config as first parameter
                state["steps"] = steps
                await adispatch_custom_event(
                    "manually_emit_state",
                    state,
                    config=config,
                )
            
            return Command(
                goto='start_flow',
                update={
                    "messages": messages,
                    "steps": state["steps"]
                }
            )

    return Command(
        goto=END,
        update={
            "messages": messages,
            "steps": state["steps"]
        }
    )


# Define the graph
workflow = StateGraph(AgentState)

# Add nodes
workflow.add_node("start_flow", start_flow)
workflow.add_node("chat_node", chat_node)

# Add edges (equivalent to the routing in CrewAI)
workflow.set_entry_point("start_flow")
workflow.add_edge(START, "start_flow")
workflow.add_edge("start_flow", "chat_node")
workflow.add_edge("chat_node", END)

# Compile the graph
graph = workflow.compile()
