"""Tool Based Generative UI feature.

No special handling is required for this feature.
"""

from fastapi import FastAPI
from autogen import ConversableAgent, LLMConfig
from autogen.ag_ui import AGUIStream


agent = ConversableAgent(
    name="haiku_bot",
    llm_config=LLMConfig({"model": "gpt-4o-mini", "stream": True}),
)

stream = AGUIStream(agent)
tool_based_generative_ui_app = FastAPI()
tool_based_generative_ui_app.mount("", stream.build_asgi())
