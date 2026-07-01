from __future__ import annotations

import os
from typing import Optional

import dotenv
dotenv.load_dotenv()

from pyagentspec.agent import Agent
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.serialization import AgentSpecSerializer
from pyagentspec.tools import ClientTool
from pyagentspec.property import StringProperty
from pathlib import Path


A2UI_PROMPT = (Path(__file__).resolve().parent / "A2UI_PROMPT.txt").read_text(encoding="utf-8")


A2UI_SYSTEM_PROMPT = f"""You are a helpful assistant that can render rich UI surfaces using the A2UI protocol.

When the user asks for visual content (cards, forms, lists, buttons, etc.), use the send_a2ui_json_to_client tool to render A2UI surfaces.

{A2UI_PROMPT}"""


agent_llm = OpenAiCompatibleConfig(
    name="my_llm",
    model_id=os.environ.get("OPENAI_MODEL", "gpt-4o"),
    url=os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1")
)

send_a2ui_json_to_client_tool = ClientTool(
    name="send_a2ui_json_to_client",
    description="Sends A2UI JSON to the client to render rich UI",
    inputs=[StringProperty(title="a2ui_json", description="valid A2UI JSON string according to the A2UI JSON Schema")]
)

agent = Agent(
    name="a2ui_chat_agent",
    llm_config=agent_llm,
    system_prompt=A2UI_SYSTEM_PROMPT,
    tools=[send_a2ui_json_to_client_tool]
)
a2ui_chat_json = AgentSpecSerializer().to_json(agent)
