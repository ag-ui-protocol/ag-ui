"""
An example demonstrating tool-based generative UI using LangGraph.
"""

from typing import List, Any, Optional, Annotated
from langchain_openai import ChatOpenAI
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command
from langgraph.graph import MessagesState
from langgraph.checkpoint.memory import MemorySaver

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

# Add edges
workflow.set_entry_point("chat_node")
workflow.add_edge(START, "chat_node")
workflow.add_edge("chat_node", END)

# Compile the graph
tool_based_generative_ui_graph = workflow.compile(checkpointer=MemorySaver())
