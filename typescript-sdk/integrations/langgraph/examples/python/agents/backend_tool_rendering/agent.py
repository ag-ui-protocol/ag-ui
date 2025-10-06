"""
A simple agentic chat flow using LangGraph instead of CrewAI.
"""

from typing import List, Any, Optional
import os

# Updated imports for LangGraph
from langchain_core.runnables import RunnableConfig
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, START
from langgraph.graph import MessagesState
from langgraph.types import Command
from requests.api import get


class AgentState(MessagesState):
    """
    State of our graph.
    """

    tools: List[Any]


@tool
def get_weather(city: str):
    return {
        "temperature": 20,
        "conditions": "sunny",
        "humidity": 50,
        "windSpeed": 10,
        "feelsLike": 25,
    }


async def chat_node(state: AgentState, config: Optional[RunnableConfig] = None):
    """
    Standard chat node based on the ReAct design pattern. It handles:
    - The model to use (and binds in CopilotKit actions and the tools defined above)
    - The system prompt
    - Getting a response from the model
    - Handling tool calls

    For more about the ReAct design pattern, see:
    https://www.perplexity.ai/search/react-agents-NcXLQhreS0WDzpVaS4m9Cg
    """

    # 1. Define the model
    model = ChatOpenAI(model="gpt-4.1-mini")

    # Define config for the model
    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # 2. Bind the tools to the model
    model_with_tools = model.bind_tools(
        [
            *state["tools"],
            get_weather,
            # your_tool_here
        ],
        # 2.1 Disable parallel tool calls to avoid race conditions,
        #     enable this for faster performance if you want to manage
        #     the complexity of running tool calls in parallel.
        parallel_tool_calls=False,
    )

    # 3. Define the system message by which the chat model will be run
    system_message = SystemMessage(content="You are a helpful assistant.")

    # 4. Run the model to generate a response
    response = await model_with_tools.ainvoke(
        [
            system_message,
            *state["messages"],
        ],
        config,
    )

    # 6. We've handled all tool calls, so we can end the graph.
    return Command(goto=END, update={"messages": response})


# Define a new graph
workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.set_entry_point("chat_node")

# Add explicit edges, matching the pattern in other examples
workflow.add_edge(START, "chat_node")
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
