"""A deepagents supervisor that delegates to several specialized research
subagents via the `task` tool.

This demo exercises AG-UI SUBAGENT_STARTED / SUBAGENT_FINISHED attribution: a
single research question fans out into multiple `task` delegations, each surfaced
as its own subagent run with a distinct `subagent_id`. The dojo groups every
subagent's messages under its own collapsible header, so a run with three
specialists shows three independent groups.
"""

import os

from langchain_openai import ChatOpenAI

from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgent

model = ChatOpenAI(model="gpt-4o-mini")

cognition_researcher: SubAgent = {
    "name": "cognition_researcher",
    "description": (
        "Researches cognitive abilities: problem-solving, learning, memory, "
        "tool use, and reasoning. Delegate to this subagent for any question "
        "about how a subject thinks or learns."
    ),
    "system_prompt": (
        "You are a cognition research specialist. Given a topic, give a "
        "concise (3-5 sentence) assessment of the cognitive abilities "
        "involved — problem-solving, learning, memory, reasoning. Be specific "
        "and avoid hedging."
    ),
    "tools": [],
}

behavior_researcher: SubAgent = {
    "name": "behavior_researcher",
    "description": (
        "Researches behavior: social interaction, communication, and "
        "personality. Delegate to this subagent for any question about how a "
        "subject acts or interacts."
    ),
    "system_prompt": (
        "You are a behavioral research specialist. Given a topic, give a "
        "concise (3-5 sentence) assessment of the observable behavior — "
        "social interaction, communication, and notable personality traits. "
        "Be specific and avoid hedging."
    ),
    "tools": [],
}

neuroscience_researcher: SubAgent = {
    "name": "neuroscience_researcher",
    "description": (
        "Researches the biological substrate: nervous system, brain or neural "
        "structure, and the mechanisms behind behavior. Delegate to this "
        "subagent for any question about the underlying biology."
    ),
    "system_prompt": (
        "You are a neuroscience research specialist. Given a topic, give a "
        "concise (3-5 sentence) assessment of the biological substrate — "
        "nervous system organization, neural mechanisms, and how they support "
        "the observed abilities. Be specific and avoid hedging."
    ),
    "tools": [],
}

SUBAGENTS = [cognition_researcher, behavior_researcher, neuroscience_researcher]

SUPERVISOR_PROMPT = """You are a research supervisor with three specialist \
subagents: `cognition_researcher`, `behavior_researcher`, and \
`neuroscience_researcher`.

For EVERY user question, you MUST gather input from ALL THREE specialists before \
answering — no exceptions, even if the question seems simple.

Always do the following, in order:
1. Call the `task` tool once with `subagent_type="cognition_researcher"`.
2. Call the `task` tool once with `subagent_type="behavior_researcher"`.
3. Call the `task` tool once with `subagent_type="neuroscience_researcher"`.
   Each call should ask that specialist to research its angle of the user's \
question.
4. Once all three have responded, synthesize their findings into a single, \
concise final answer for the user.

Delegate every angle - do not skip any specialist, and do not answer from your \
own knowledge instead of delegating."""

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
        subagents=SUBAGENTS,
        checkpointer=MemorySaver(),
    )
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = create_deep_agent(
        model=model,
        tools=[],
        system_prompt=SUPERVISOR_PROMPT,
        subagents=SUBAGENTS,
    )
