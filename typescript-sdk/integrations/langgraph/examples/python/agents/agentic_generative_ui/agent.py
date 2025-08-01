"""
An example demonstrating agentic generative UI using LangGraph.
"""

import asyncio
from typing import List, Any, Optional, Annotated
import os

# LangGraph imports
from langchain_core.runnables import RunnableConfig
from langchain_core.callbacks.manager import adispatch_custom_event
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command
from langgraph.graph import MessagesState
from pydantic import BaseModel, Field

class Step(BaseModel):
    """
    A step in a task.
    """
    description: str = Field(description="The text of the step in gerund form")
    status: str = Field(description="The status of the step, always 'pending'")



# This tool simulates performing a task on the server.
# The tool call will be streamed to the frontend as it is being generated.
@tool
def generate_task_steps_generative_ui(
    steps: Annotated[ # pylint: disable=unused-argument
        List[Step],
        "An array of 10 step objects, each containing text and status"
    ]
):
    """
    Make up 10 steps (only a couple of words per step) that are required for a task.
    The step should be in gerund form (i.e. Digging hole, opening door, ...).
    """


class AgentState(MessagesState):
    """
    State of the agent.
    """
    steps: List[dict] = []
    tools: List[Any]


async def start_node(state: AgentState, config: RunnableConfig): # pylint: disable=unused-argument
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


async def chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
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
            generate_task_steps_generative_ui
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
        # Handle dicts or object (backward compatibility)
        tool_call = (response.tool_calls[0]
                     if isinstance(response.tool_calls[0], dict)
                     else vars(response.tool_calls[0]))

        if tool_call["name"] == "generate_task_steps_generative_ui":
            steps = [
                {"description": step["description"], "status": step["status"]}
                for step in tool_call["args"]["steps"]
            ]

            # Add the tool response to messages
            tool_response = {
                "role": "tool",
                "content": "Steps executed.",
                "tool_call_id": tool_call["id"]
            }

            messages = messages + [tool_response]
            state["steps"] = steps

            # Return Command to route to simulate_task_node
            for i, _ in enumerate(steps):
            # simulate executing the step
                await asyncio.sleep(1)
                steps[i]["status"] = "completed"
                # Update the state with the completed step using config
                await adispatch_custom_event(
                    "manually_emit_state",
                    state,
                    config=config,
                )

            return Command(
                goto='start_node',
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
workflow.add_node("start_node", start_node)
workflow.add_node("chat_node", chat_node)

# Add edges
workflow.set_entry_point("start_node")
workflow.add_edge(START, "start_node")
workflow.add_edge("start_node", "chat_node")
workflow.add_edge("chat_node", END)

# Conditionally use a checkpointer based on the environment
# Check for multiple indicators that we're running in LangGraph dev/API mode
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = workflow.compile()
