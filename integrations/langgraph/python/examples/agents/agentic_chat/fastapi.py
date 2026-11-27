"""Stock AG-UI adapter for the LangGraph FastAPI chat example."""

from ag_ui_langgraph import RunGuidanceAgentMixin, RunGuidanceMiddleware
from copilotkit import CopilotKitMiddleware, CopilotKitState, LangGraphAGUIAgent
from langchain.agents import create_agent
from langchain_core.language_models.chat_models import BaseChatModel
from langgraph.checkpoint.memory import MemorySaver

DEFAULT_MODEL = "openai:gpt-4.1-mini"


def create_chat_graph(
    *, model: str | BaseChatModel = DEFAULT_MODEL, fastapi: bool = False
):
    middleware = [CopilotKitMiddleware()]
    if fastapi:
        middleware.append(RunGuidanceMiddleware())
    return create_agent(
        model=model,
        tools=[],
        middleware=middleware,
        system_prompt="You are a helpful assistant.",
        checkpointer=MemorySaver() if fastapi else None,
        state_schema=CopilotKitState,
    )


class _FastAPIChatAgent(RunGuidanceAgentMixin, LangGraphAGUIAgent):
    pass


def create_fastapi_agent(
    *, model: str | BaseChatModel = DEFAULT_MODEL
) -> LangGraphAGUIAgent:
    """Build the checkpointed Dojo chat agent."""
    return _FastAPIChatAgent(
        name="agentic_chat",
        description="An example for an agentic chat flow using LangGraph.",
        graph=create_chat_graph(model=model, fastapi=True),
    )
