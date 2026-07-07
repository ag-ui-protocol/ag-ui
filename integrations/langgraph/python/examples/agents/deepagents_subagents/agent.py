"""A deepagents supervisor that delegates to a specialized research
subagent via the `task` tool.

This demo exists to exercise the AG-UI SUBAGENT_STARTED / SUBAGENT_FINISHED
event attribution for deepagents subagents: a single user question should
reliably fan out into a `task` delegation (market research), surfaced as its
own subagent run with a distinct `subagent_id`.

NOTE: This demo is temporarily reduced to a SINGLE subagent to isolate and
iterate on the MESSAGES_SNAPSHOT subagent-attribution fix. The full
three-subagent version (market, technical, and risk research) will be
restored once the fix is validated.
"""

import os

from langchain_openai import ChatOpenAI

from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgent

model = ChatOpenAI(model="gpt-4o-mini")

market_researcher: SubAgent = {
    "name": "market_researcher",
    "description": (
        "Researches market size, target customers, competitors, and demand "
        "for a product or business idea. Delegate to this subagent for any "
        "market-related sub-question."
    ),
    "system_prompt": (
        "You are a market research analyst. Given a product or business "
        "idea, give a concise (3-5 sentence) assessment of the target "
        "market, likely customers, and competitive landscape. Be specific "
        "and avoid hedging."
    ),
    "tools": [],
}

SUPERVISOR_PROMPT = """You are a research supervisor. For EVERY user question \
about a product, business, or idea, you MUST gather input from your market \
research specialist subagent before answering - no exceptions, even if the \
question seems simple.

Always do the following, in order:
1. Call the `task` tool with `subagent_type="market_researcher"`, asking it \
to research the market angle of the user's question.
2. Once it has responded, synthesize its findings into a single, concise \
final answer for the user.

Delegate the task - do not skip it, and do not answer from your own knowledge \
instead of delegating."""

# Conditionally use a checkpointer based on the environment (matches the
# pattern used by the sibling example agents).
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver

    graph = create_deep_agent(
        model=model,
        tools=[],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=[market_researcher],
        checkpointer=MemorySaver(),
    )
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = create_deep_agent(
        model=model,
        tools=[],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=[market_researcher],
    )
