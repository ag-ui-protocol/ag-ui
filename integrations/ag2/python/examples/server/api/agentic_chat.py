"""Agentic Chat example using AG2 with AG-UI protocol.

Exposes a ConversableAgent via AGUIStream for the AG-UI Dojo.
See: https://docs.ag2.ai/latest/docs/user-guide/ag-ui/
"""

from fastapi import FastAPI
from autogen import ConversableAgent, LLMConfig
from autogen.ag_ui import AGUIStream

agent = ConversableAgent(
    name="support_bot",
    system_message="You are a helpful assistant. You answer product questions and help users.",
    llm_config=LLMConfig({"model": "gpt-4o-mini", "stream": True}),
)

stream = AGUIStream(agent)
agentic_chat_app = FastAPI()
agentic_chat_app.mount("", stream.build_asgi())
