"""
Dynamic A2UI tool: LLM-generated UI from conversation context.

A secondary LLM generates v0.9 A2UI components via a structured tool call.
The generate_a2ui tool wraps the output as a2ui_operations, which the
middleware detects in the TOOL_CALL_RESULT and renders automatically.
"""

import json
import os
from typing import Any, List

from langchain.tools import tool, ToolRuntime
from langchain_core.messages import SystemMessage
from langchain_core.tools import tool as lc_tool
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END, MessagesState
from langgraph.prebuilt import ToolNode

from copilotkit import a2ui

A2UI_GENERATION_PROMPT = a2ui.a2ui_prompt()


@lc_tool
def render_a2ui(
    surfaceId: str,
    components: list[dict],
    items: list[dict],
    actionHandlers: dict | None = None,
) -> str:
    """Render a dynamic A2UI v0.9 surface.

    Args:
        surfaceId: Unique surface identifier.
        components: A2UI v0.9 component array (flat format). The root
            component must have id "root". Use a List with
            children: { componentId, path: "/items" } for repeating cards.
        items: Plain JSON array of data objects. Each object's keys
            correspond to the path bindings in the template components.
            Use relative paths (no leading /) inside templates.
        actionHandlers: Optional dict mapping action names to arrays of
            v0.9 A2UI operations for optimistic UI updates on button click.
    """
    return "rendered"


@tool()
def generate_a2ui(runtime: ToolRuntime[Any]) -> str:
    """Generate dynamic A2UI components based on the conversation.

    A secondary LLM designs the UI schema and data. The result is
    returned as an a2ui_operations container for the middleware to detect.
    """
    # The last message is this tool call (generate_a2ui) so we remove it,
    # as it is not yet balanced with a tool call response.
    messages = runtime.state["messages"][:-1]

    model = ChatOpenAI(model="gpt-4.1")
    model_with_tool = model.bind_tools(
        [render_a2ui],
        tool_choice="render_a2ui",
    )

    response = model_with_tool.invoke(
        [SystemMessage(content=A2UI_GENERATION_PROMPT), *messages],
    )

    # Extract the render_a2ui tool call arguments
    tool_call = response.tool_calls[0]
    args = tool_call["args"]

    surface_id = args.get("surfaceId", "dynamic-surface")
    components = args.get("components", [])
    items = args.get("items", [])
    action_handlers = args.get("actionHandlers")

    # Wrap as v0.9 a2ui_operations so the middleware detects it
    return a2ui.render(
        operations=[
            a2ui.create_surface(surface_id),
            a2ui.update_components(surface_id, components),
            a2ui.update_data_model(surface_id, {"items": items}),
        ],
        action_handlers=action_handlers,
    )


TOOLS = [generate_a2ui]


class AgentState(MessagesState):
    tools: List[Any]


SYSTEM_PROMPT = """You are a helpful assistant that creates rich visual UI on the fly.

When the user asks for visual content (product comparisons, dashboards, lists, cards, etc.),
use the generate_a2ui tool to create a dynamic A2UI surface.
IMPORTANT: After calling the tool, do NOT repeat the data in your text response. The tool renders UI automatically. Just confirm what was rendered."""


async def chat_node(state: AgentState, config: RunnableConfig):
    model = ChatOpenAI(model="gpt-4o")
    model = model.bind_tools(TOOLS, parallel_tool_calls=False)

    response = await model.ainvoke([
        SystemMessage(content=SYSTEM_PROMPT),
        *state["messages"],
    ], config)

    return {"messages": [response]}


def route_after_chat(state: AgentState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tool_node"
    return END


workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(tools=TOOLS))
workflow.set_entry_point("chat_node")
workflow.add_conditional_edges("chat_node", route_after_chat)
workflow.add_edge("tool_node", "chat_node")

is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
