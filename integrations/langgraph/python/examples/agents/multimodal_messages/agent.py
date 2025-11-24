"""
An example demonstrating multimodal message support with images.

This agent demonstrates how to:
1. Receive user messages with images
2. Process multimodal content (text + images)
3. Use vision models to analyze images
"""

from typing import List, Any, Optional
import os

from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, START
from langgraph.graph import MessagesState
from langgraph.types import Command

class AgentState(MessagesState):
    """
    State of our graph.
    """
    tools: List[Any]

async def vision_chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
    """
    Chat node that supports multimodal input including images.

    The messages in state can contain multimodal content with text and images.
    LangGraph will automatically handle the conversion from AG-UI format to
    the format expected by the vision model.
    """

    # 1. Use a vision-capable model
    # GPT-4o supports vision, as do other models like Claude 3
    model = ChatOpenAI(model="gpt-4o")

    # Define config for the model
    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # 2. Bind tools if needed
    model_with_tools = model.bind_tools(
        state.get("tools", []),
        parallel_tool_calls=False,
    )

    # 3. Define the system message
    system_message = SystemMessage(
        content=(
            "You are a helpful vision assistant. You can analyze images and "
            "answer questions about them. Describe what you see in detail."
        )
    )

    # 4. Run the model with multimodal messages
    # The messages may contain both text and images
    response = await model_with_tools.ainvoke([
        system_message,
        *state["messages"],
    ], config)

    # 5. Return the response
    return Command(
        goto=END,
        update={
            "messages": response
        }
    )

# Define a new graph
workflow = StateGraph(AgentState)
workflow.add_node("vision_chat_node", vision_chat_node)
workflow.set_entry_point("vision_chat_node")

# Add edges
workflow.add_edge(START, "vision_chat_node")
workflow.add_edge("vision_chat_node", END)

# Conditionally use a checkpointer based on the environment
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
