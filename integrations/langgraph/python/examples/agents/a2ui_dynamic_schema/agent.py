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


@lc_tool
def render_a2ui(
    surfaceId: str,
    catalogId: str,
    components: list[dict],
    data: dict | None = None,
) -> str:
    """Render a dynamic A2UI v0.9 surface.

    Args:
        surfaceId: Unique surface identifier.
        catalogId: The catalog ID (use "https://a2ui.org/demos/dojo/custom_catalog.json").
        components: A2UI v0.9 component array (flat format). The root
            component must have id "root".
        data: Optional initial data model for the surface (e.g. form values,
            list items for data-bound components).
    """
    return "rendered"


def _build_context_prompt(state: dict) -> str:
    """Build the A2UI generation prompt from client-provided context entries.

    The frontend sends generation guidelines, design guidelines, and the
    component schema as separate context entries. The LangGraph integration
    also extracts the schema into state["ag-ui"]["a2ui_schema"].
    """
    ag_ui = state.get("ag-ui", {})
    parts: list[str] = []

    # Include all context entries (generation guidelines, design guidelines, etc.)
    # Entries may be Pydantic Context objects or plain dicts.
    for entry in ag_ui.get("context", []):
        desc = entry.description
        value = entry.value
        if desc:
            parts.append(f"## {desc}\n{value}\n")
        else:
            parts.append(f"{value}\n")

    # Include A2UI component schema (separated out by the LangGraph integration)
    a2ui_schema = ag_ui.get("a2ui_schema")
    if a2ui_schema:
        parts.append(f"## Available Components\n{a2ui_schema}\n")

    return "\n".join(parts)


CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/custom_catalog.json"


@tool()
def generate_a2ui(runtime: ToolRuntime[Any]) -> str:
    """Generate dynamic A2UI components based on the conversation.

    A secondary LLM designs the UI schema and data. The result is
    returned as an a2ui_operations container for the middleware to detect.
    """
    # The last message is this tool call (generate_a2ui) so we remove it,
    # as it is not yet balanced with a tool call response.
    messages = runtime.state["messages"][:-1]

    # Build prompt entirely from client-provided context (generation guidelines,
    # design guidelines, component schema, etc.)
    prompt = _build_context_prompt(runtime.state)

    model = ChatOpenAI(model="gpt-4.1")
    model_with_tool = model.bind_tools(
        [render_a2ui],
        tool_choice="render_a2ui",
    )

    response = model_with_tool.invoke(
        [SystemMessage(content=prompt), *messages],
    )

    # Extract the render_a2ui tool call arguments
    if not response.tool_calls:
        return json.dumps({"error": "LLM did not call render_a2ui"})

    tool_call = response.tool_calls[0]
    args = tool_call["args"]

    surface_id = args.get("surfaceId", "dynamic-surface")
    catalog_id = args.get("catalogId", CUSTOM_CATALOG_ID)
    components = args.get("components", [])
    data = args.get("data", {})

    # Wrap as v0.9 a2ui_operations so the middleware detects it
    ops = [
        a2ui.create_surface(surface_id, catalog_id=catalog_id),
        a2ui.update_components(surface_id, components),
    ]
    if data:
        ops.append(a2ui.update_data_model(surface_id, data))

    result = a2ui.render(operations=ops)
    return result


TOOLS = [generate_a2ui]


class AgentState(MessagesState):
    tools: List[Any]
    copilotkit: dict  # CopilotKit context (actions, etc.)

# LangGraph requires state keys declared in the schema.
# "ag-ui" uses a hyphen which isn't valid as a Python identifier,
# so we patch it into the annotations directly.
AgentState.__annotations__["ag-ui"] = dict


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
