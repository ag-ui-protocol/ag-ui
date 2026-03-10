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
from langroid.language_models import OpenAIChatModel
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
    chat_model=OpenAIChatModel.GPT4_1_MINI,
    api_key=os.getenv("OPENAI_API_KEY"),
    temperature=0.0,
)

agent_config = lr.ChatAgentConfig(
    name="Assistant",
    llm=llm_config,
    system_message="""You are a helpful assistant. 
When you change the background, always confirm the action to the user with a friendly message like 'I've changed the background to [color/gradient] for you!' or similar.""",
    use_tools=True,
    use_functions_api=True,
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

# DEBUG: Wrap the agent's run method to add logging
import sys
_original_run = agui_agent.run
async def _debug_run(input_data):
    print(f"[DEBUG] agentic_chat run called, user_msg={input_data.messages[-1].content if input_data.messages else 'none'}", file=sys.stderr, flush=True)
    print(f"[DEBUG] tools={[t.get('name') if isinstance(t, dict) else getattr(t, 'name', '?') for t in (input_data.tools or [])]}", file=sys.stderr, flush=True)
    event_count = 0
    async for event in _original_run(input_data):
        event_count += 1
        print(f"[DEBUG] Event #{event_count}: {event.type} - {str(event)[:200]}", file=sys.stderr, flush=True)
        yield event
    print(f"[DEBUG] Total events: {event_count}", file=sys.stderr, flush=True)
agui_agent.run = _debug_run

app = create_langroid_app(agui_agent, "/")

