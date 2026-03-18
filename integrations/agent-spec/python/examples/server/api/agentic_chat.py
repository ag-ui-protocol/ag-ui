"""
A simple ReAct-style agentic chat Flow using pyagentspec.

This mirrors the LangGraph example structure by:
- Defining a single agent capable of tool use (ReAct loop handled by the agent runtime)
- Wiring a minimal Flow: Start -> AgentNode -> End
- Exposing a top-level `assistant` (Flow) variable for integrations to import

Note:
- This file defines the Flow and its components declaratively.
- Actual tool execution is orchestrator-dependent (e.g., ServerTool/BuiltinTool are executed by the backend/orchestrator).
"""

from __future__ import annotations

import os
from typing import Optional

import dotenv
dotenv.load_dotenv()

from pyagentspec.agent import Agent
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.serialization import AgentSpecSerializer
from pyagentspec.tools import ClientTool
from pyagentspec.property import Property


agent_llm = OpenAiCompatibleConfig(
    name="my_llm",
    model_id=os.environ.get("OPENAI_MODEL", "gpt-4o"),
    url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
)

change_background_frontend_tool = ClientTool(
    name="change_background",
    description="Change the background color of the chat. Can be anything that the CSS background attribute accepts. Regular colors, linear of radial gradients etc.",
    inputs=[Property(title="background", json_schema={"title": "background", "type": "string", "description": "The background. Prefer gradients."})]
)

agent = Agent(
    name="agentic_chat_agent",
    llm_config=agent_llm,
    system_prompt="Be friendly.",
    tools=[change_background_frontend_tool]
)
agentic_chat_json = AgentSpecSerializer().to_json(agent)
