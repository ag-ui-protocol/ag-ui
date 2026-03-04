"""
A2UI Chat - Agent that can render A2UI surfaces.

Demonstrates two A2UI rendering paths:
1. LLM-driven: The LLM calls send_a2ui_json_to_client (injected by middleware)
2. Backend-driven: Backend tools return A2UI JSON, auto-detected by middleware
"""

import json
import os
from typing import Any, List
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from langgraph.graph import StateGraph, END
from langgraph.graph import MessagesState
from langgraph.prebuilt import ToolNode

from agents.a2ui_chat.prompt import A2UI_PROMPT


# --- Backend tools that return A2UI JSON ---

LOGIN_FORM_A2UI = [
    {
        "surfaceUpdate": {
            "surfaceId": "login-form",
            "components": [
                {"id": "root", "component": {"Card": {"child": "form-col"}}},
                {"id": "form-col", "component": {"Column": {"children": {"explicitList": ["title", "username-field", "password-field", "login-btn"]}}}},
                {"id": "title", "component": {"Text": {"text": {"literalString": "Login"}, "usageHint": "h2"}}},
                {"id": "username-field", "component": {"TextField": {"label": {"literalString": "Username"}, "text": {"path": "/form/username"}}}},
                {"id": "password-field", "component": {"TextField": {"label": {"literalString": "Password"}, "text": {"path": "/form/password"}, "textFieldType": "obscured"}}},
                {"id": "login-btn", "component": {"Button": {"child": "btn-text", "primary": True, "action": {"name": "login", "context": [{"key": "username", "value": {"path": "/form/username"}}, {"key": "password", "value": {"path": "/form/password"}}]}}}},
                {"id": "btn-text", "component": {"Text": {"text": {"literalString": "Sign In"}}}}
            ]
        }
    },
    {
        "dataModelUpdate": {
            "surfaceId": "login-form",
            "contents": [
                {"key": "form", "valueMap": [{"key": "username", "valueString": ""}, {"key": "password", "valueString": ""}]}
            ]
        }
    },
    {
        "beginRendering": {
            "surfaceId": "login-form",
            "root": "root"
        }
    }
]


@tool
def show_login_form() -> str:
    """Show a login form to the user. Call this when the user wants to log in or needs authentication."""
    return json.dumps(LOGIN_FORM_A2UI)


BACKEND_TOOLS = [show_login_form]
BACKEND_TOOL_NAMES = {t.name for t in BACKEND_TOOLS}


# --- Agent state and graph ---

class AgentState(MessagesState):
    """State with tools from frontend."""
    tools: List[Any]


SYSTEM_PROMPT = f"""You are a helpful assistant that can render rich UI surfaces using the A2UI protocol.

When the user asks for visual content (cards, forms, lists, buttons, etc.), use the send_a2ui_json_to_client tool to render A2UI surfaces.

You also have a backend tool called show_login_form that renders a pre-built login form.
When the user asks to log in or for a login form, use the show_login_form tool.

{A2UI_PROMPT}"""


async def chat_node(state: AgentState, config: RunnableConfig):
    """Chat node that binds both backend and frontend tools, then calls the LLM."""

    frontend_tools = state.get("tools", [])
    all_tools = BACKEND_TOOLS + frontend_tools
    model = ChatOpenAI(model="gpt-4o")

    if all_tools:
        model = model.bind_tools(all_tools, parallel_tool_calls=False)

    system_message = SystemMessage(content=SYSTEM_PROMPT)

    response = await model.ainvoke([
        system_message,
        *state["messages"],
    ], config)

    return {"messages": [response]}


def route_after_chat(state: AgentState):
    """Route to tool_node for backend tool calls, otherwise END.

    Frontend tools (like send_a2ui_json_to_client) are handled by the
    middleware at the event stream level and don't need graph execution.
    """
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        for tc in last_message.tool_calls:
            if tc["name"] in BACKEND_TOOL_NAMES:
                return "tool_node"
    return END


# Build the graph
workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(tools=BACKEND_TOOLS))
workflow.set_entry_point("chat_node")
workflow.add_conditional_edges("chat_node", route_after_chat)
workflow.add_edge("tool_node", "chat_node")

# Conditionally use a checkpointer based on the environment
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
