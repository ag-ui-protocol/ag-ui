"""
An example demonstrating tool-based generative UI using LangGraph.
"""

import os
from typing import Any, List
from typing_extensions import Literal
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END
from langgraph.types import Command
from langgraph.graph import MessagesState
from langgraph.prebuilt import ToolNode

# This tool generates a haiku on the server.
# The tool call will be streamed to the frontend as it is being generated.
GENERATE_HAIKU_TOOL = {
    "type": "function",
    "function": {
        "name": "generate_haiku",
        "description": "Generate a haiku in Japanese and its English translation",
        "parameters": {
            "type": "object",
            "properties": {
                "japanese": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "An array of three lines of the haiku in Japanese"
                },
                "english": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "An array of three lines of the haiku in English"
                },
                "image_names": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "Names of 3 relevant images from the provided list"
                }
            },
            "required": ["japanese", "english", "image_names"]
        }
    }
}

class AgentState(MessagesState):
    """
    State of the agent.
    """
    tools: List[Any] = []

async def chat_node(state: AgentState, config: RunnableConfig) -> Command[Literal["tool_node", "__end__"]]:
    """
    Standard chat node based on the ReAct design pattern. It handles:
    - The model to use (and binds in CopilotKit actions and the tools defined above)
    - The system prompt
    - Getting a response from the model
    - Handling tool calls

    For more about the ReAct design pattern, see:
    https://www.perplexity.ai/search/react-agents-NcXLQhreS0WDzpVaS4m9Cg
    """

    model = ChatOpenAI(model="gpt-4o")

    model_with_tools = model.bind_tools(
        [
            *state.get("tools", []), # bind tools defined by ag-ui
            GENERATE_HAIKU_TOOL,
        ],
        parallel_tool_calls=False,
    )

    system_message = SystemMessage(
        content=f"Help the user with writing Haikus. If the user asks for a haiku, use the generate_haiku tool to display the haiku to the user."
    )

    response = await model_with_tools.ainvoke([
        system_message,
        *state["messages"],
    ], config)

    return Command(
        goto=END,
        update={
            "messages": [response],
        }
    )

workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
# This is required even though we don't have any backend tools to pass in.
workflow.add_node("tool_node", ToolNode(tools=[]))
workflow.set_entry_point("chat_node")
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
