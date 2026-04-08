"""
A multimodal agentic chat that can analyze images and other media.
"""

import os

from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, START
from langgraph.graph import MessagesState
from langgraph.types import Command
from langgraph.checkpoint.memory import MemorySaver
from typing import List, Any, Optional


class AgentState(MessagesState):
    """
    State of our graph.
    """
    tools: List[Any]


async def chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
    """
    Chat node that uses a vision-capable model to handle multimodal input.
    Images and other media sent by the user are automatically converted
    to LangChain's multimodal format by the AG-UI integration layer.
    """

    model = ChatOpenAI(model="gpt-5.2")

    if config is None:
        config = RunnableConfig(recursion_limit=25)

    model_with_tools = model.bind_tools(
        [
            *state["tools"],
        ],
    )

    system_message = SystemMessage(
        content="You are a helpful assistant that can analyze images, documents, and other media. "
                "When a user shares an image, describe what you see in detail. "
                "When a user shares a document, summarize its contents."
    )

    response = await model_with_tools.ainvoke([
        system_message,
        *state["messages"],
    ], config)

    return Command(
        goto=END,
        update={
            "messages": response
        }
    )


# Define a new graph
workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.set_entry_point("chat_node")

workflow.add_edge(START, "chat_node")
workflow.add_edge("chat_node", END)

is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
