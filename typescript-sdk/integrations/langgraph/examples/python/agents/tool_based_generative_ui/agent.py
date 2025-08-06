"""
An example demonstrating tool-based generative UI using LangGraph.
"""

from typing import List, Any, Optional, Annotated
import os

# LangGraph imports
from langchain_openai import ChatOpenAI
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command
from langgraph.graph import MessagesState
from langgraph.prebuilt import ToolNode

@tool
def generate_haiku(
    japanese: Annotated[ # pylint: disable=unused-argument
        List[str],
        "An array of three lines of the haiku in Japanese"
    ],
    english: Annotated[ # pylint: disable=unused-argument
        List[str],
        "An array of three lines of the haiku in English"
    ]
):
    """
    Generate a haiku in Japanese and its English translation.
    Also select exactly 3 relevant images from the provided list based on the haiku's theme.
    """

class AgentState(MessagesState):
    """
    State of the agent.
    """
    tools: List[Any]

async def chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
    """
    The main function handling chat and tool calls.
    """

    system_prompt = """
        You assist the user in generating a haiku.
        When generating a haiku using the 'generate_haiku' tool.
    """

    # Define the model
    model = ChatOpenAI(model="gpt-4o")

    # Define config for the model
    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # Bind the tools to the model
    model_with_tools = model.bind_tools(
        [generate_haiku],
        # Disable parallel tool calls to avoid race conditions
        parallel_tool_calls=False,
    )

    # Run the model to generate a response
    response = await model_with_tools.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)

    if response.tool_calls:
        return Command(
            goto="tool_node",
            update={
                "messages": state["messages"] + [response]
            }
        )
    # Return Command to end with updated messages
    return Command(
        goto=END,
        update={
            "messages": state["messages"] + [response]
        }
    )

# Define the graph
workflow = StateGraph(AgentState)

# Add nodes
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode([generate_haiku]))

# Add edges
workflow.set_entry_point("chat_node")
workflow.add_edge(START, "chat_node")
workflow.add_edge("chat_node", END)
workflow.add_edge("tool_node", END)


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

