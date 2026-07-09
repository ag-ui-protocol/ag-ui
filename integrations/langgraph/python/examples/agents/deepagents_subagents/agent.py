"""A deepagents supervisor that delegates to three specialized research
subagents via the `task` tool, running them in parallel.

This demo exercises AG-UI SUBAGENT_STARTED / SUBAGENT_FINISHED attribution: a
single research question fans out into three concurrent `task` delegations,
each surfaced as its own subagent run with a distinct `subagent_id`. The dojo
groups every subagent's messages (text + tool calls) under its own collapsible
header, so a run shows three independent, concurrently-streaming groups.

Each specialist is prompted to USE its tools (write_todos to plan, write_file
to record notes) before answering, so the subagents produce visible tool-call
activity — not just a text answer.
"""

import os

from langchain_openai import ChatOpenAI

from deepagents import create_deep_agent
from deepagents.middleware.subagents import SubAgent

model = ChatOpenAI(model="gpt-4o-mini")


def _specialist_prompt(role: str, focus: str, notes_file: str) -> str:
    """Build a specialist system prompt that mandates tool use before answering.

    deepagents gives every subagent the built-in todo + filesystem tools
    (write_todos, write_file, …) via middleware. Instructing the specialist to
    use them makes the subagent's work visible as tool-call cards in the dojo,
    rather than collapsing to a single text reply.
    """
    return (
        f"You are a {role}. Focus area: {focus}.\n\n"
        "Always do ALL of the following, in order, before writing your answer:\n"
        "1. Call `write_todos` to lay out the 2-3 sub-questions you will cover.\n"
        f"2. Call `write_file` to save your working notes to `{notes_file}`.\n"
        "3. Then give a concise (3-5 sentence) assessment of your focus area.\n\n"
        "Use the tools every time - do not answer from memory without first "
        "planning with write_todos and recording notes with write_file. Be "
        "specific and avoid hedging."
    )


cognition_researcher: SubAgent = {
    "name": "cognition_researcher",
    "description": (
        "Researches cognitive abilities: problem-solving, learning, memory, "
        "tool use, and reasoning. Delegate for any question about how a "
        "subject thinks or learns."
    ),
    "system_prompt": _specialist_prompt(
        "cognition research specialist",
        "cognitive abilities — problem-solving, learning, memory, reasoning",
        "cognition_notes.md",
    ),
}

behavior_researcher: SubAgent = {
    "name": "behavior_researcher",
    "description": (
        "Researches behavior: social interaction, communication, and "
        "personality. Delegate for any question about how a subject acts or "
        "interacts."
    ),
    "system_prompt": _specialist_prompt(
        "behavioral research specialist",
        "observable behavior — social interaction, communication, personality",
        "behavior_notes.md",
    ),
}

neuroscience_researcher: SubAgent = {
    "name": "neuroscience_researcher",
    "description": (
        "Researches the biological substrate: nervous system, brain or neural "
        "structure, and the mechanisms behind behavior. Delegate for any "
        "question about the underlying biology."
    ),
    "system_prompt": _specialist_prompt(
        "neuroscience research specialist",
        "biological substrate — nervous system organization, neural mechanisms",
        "neuroscience_notes.md",
    ),
}

SUBAGENTS = [cognition_researcher, behavior_researcher, neuroscience_researcher]

SUPERVISOR_PROMPT = """You are a research supervisor with three specialist \
subagents: `cognition_researcher`, `behavior_researcher`, and \
`neuroscience_researcher`.

For EVERY user question you MUST consult ALL THREE specialists, and you MUST run \
them IN PARALLEL. In a SINGLE step, emit three `task` tool calls at once — one \
with `subagent_type="cognition_researcher"`, one with \
`subagent_type="behavior_researcher"`, and one with \
`subagent_type="neuroscience_researcher"` — each asking that specialist to \
research its angle of the user's question.

Do NOT call the specialists one at a time, and do NOT wait for one to finish \
before starting the next — issue all three task calls together so they execute \
concurrently. Once all three have responded, synthesize their findings into a \
single, concise final answer for the user."""

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
