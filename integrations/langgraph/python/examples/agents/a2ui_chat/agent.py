"""
A2UI Chat - Agent that can render A2UI surfaces.
"""

import os
from typing import Any, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END
from langgraph.types import Command
from langgraph.graph import MessagesState
from langgraph.prebuilt import ToolNode

from .prompt import A2UI_PROMPT


class AgentState(MessagesState):
    """State with tools from frontend."""
    tools: List[Any]


# System prompt with A2UI instructions
SYSTEM_PROMPT = f"""You are a helpful assistant that can render rich UI surfaces using the A2UI protocol.

When the user asks for visual content (cards, forms, lists, buttons, etc.), use the send_a2ui_json_to_client tool to render A2UI surfaces.

{A2UI_PROMPT}"""


async def chat_node(state: AgentState, config: RunnableConfig) -> Command:
    """Chat node that binds tools from state and calls the LLM."""

    tools = state.get("tools", [])
    model = ChatOpenAI(model="gpt-4o")

    if tools:
        model = model.bind_tools(tools, parallel_tool_calls=False)

    system_message = SystemMessage(content=SYSTEM_PROMPT)

    response = await model.ainvoke([
        system_message,
        *state["messages"],
    ], config)

    return Command(
        goto=END,
        update={"messages": [response]},
    )


# Build the graph
workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(tools=[]))
workflow.set_entry_point("chat_node")
workflow.add_edge("chat_node", END)

# Conditionally use a checkpointer based on the environment
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
