from __future__ import annotations

import importlib.util
import logging
from fastapi import APIRouter

from ag_ui_agentspec.agent import AgentSpecAgent
from ag_ui_agentspec.endpoint import add_agentspec_fastapi_endpoint
from server.api.agentic_chat import agentic_chat_json
from server.api.backend_tool_rendering import (
    backend_tool_rendering_agent_json,
    tool_registry as backend_tool_registry,
)
from server.api.human_in_the_loop import human_in_the_loop_agent_json
from server.api.tool_based_generative_ui import tool_based_generative_ui_agent_json

logger = logging.getLogger(__name__)
router = APIRouter()


def _is_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _mount(router: APIRouter):
    if _is_available("langgraph"):
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(agentic_chat_json, runtime="langgraph"),
            path="/langgraph/agentic_chat",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(
                backend_tool_rendering_agent_json,
                runtime="langgraph",
                tool_registry=backend_tool_registry,
            ),
            path="/langgraph/backend_tool_rendering",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(human_in_the_loop_agent_json, runtime="langgraph"),
            path="/langgraph/human_in_the_loop",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(
                tool_based_generative_ui_agent_json, runtime="langgraph"
            ),
            path="/langgraph/tool_based_generative_ui",
        )
    else:
        logger.info("LangGraph not available. Skipping Agent Spec (LangGraph) endpoints.")

    if _is_available("wayflowcore"):
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(agentic_chat_json, runtime="wayflow"),
            path="/wayflow/agentic_chat",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(
                backend_tool_rendering_agent_json,
                runtime="wayflow",
                tool_registry=backend_tool_registry,
            ),
            path="/wayflow/backend_tool_rendering",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(human_in_the_loop_agent_json, runtime="wayflow"),
            path="/wayflow/human_in_the_loop",
        )
        add_agentspec_fastapi_endpoint(
            app=router,
            agentspec_agent=AgentSpecAgent(
                tool_based_generative_ui_agent_json, runtime="wayflow"
            ),
            path="/wayflow/tool_based_generative_ui",
        )
    else:
        logger.info("Wayflow (wayflowcore) not available. Skipping Agent Spec (Wayflow) endpoints.")

_mount(router)