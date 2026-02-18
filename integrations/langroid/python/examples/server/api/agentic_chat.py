"""Agentic Chat example for Langroid.

Simple conversational agent with change_background frontend tool.
"""
import os
from pathlib import Path
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

import langroid as lr
from langroid.agent import ToolMessage
from ag_ui_langroid import LangroidAgent, create_langroid_app


class ChangeBackgroundTool(ToolMessage):
    request: str = "change_background"
    purpose: str = """
        Change the background color of the chat. Can be anything that the CSS background
        attribute accepts. Regular colors, linear or radial gradients etc.
        Only use when the user explicitly asks to change the background.
    """
    background: str

llm_config = lr.language_models.OpenAIGPTConfig(
    chat_model=lr.language_models.OpenAIChatModel.GPT4o,
    api_key=os.getenv("OPENAI_API_KEY"),
)

agent_config = lr.ChatAgentConfig(
    name="Assistant",
    llm=llm_config,
    system_message="""You are a helpful assistant. 
When you change the background, always confirm the action to the user with a friendly message like 'I've changed the background to [color/gradient] for you!' or similar.""",
    use_tools=True,
    use_functions_api=False,
)

chat_agent = lr.ChatAgent(agent_config)
chat_agent.enable_message(ChangeBackgroundTool)

task = lr.Task(
    chat_agent,
    name="Assistant",
    interactive=False,
    single_round=False,
)

agui_agent = LangroidAgent(
    agent=task,
    name="agentic_chat",
    description="Simple conversational Langroid agent with frontend tools",
)

app = create_langroid_app(agui_agent, "/")

