"""Orchestrator — multi-agent via the SDK's agents-as-tools pattern.

Complements :mod:`handoff`: there, control *transfers* to the specialist
(triage agent exits the conversation). Here the orchestrator stays in charge
and *calls* specialists as tools (``Agent.as_tool()``), possibly several in
one turn, then synthesizes their outputs itself.

On the AG-UI side each specialist invocation is an ordinary
``TOOL_CALL_START/ARGS/END`` + ``TOOL_CALL_RESULT`` sequence — the nested
agent's own model turns stay internal to the SDK and are not streamed as
separate messages, so the client sees one coherent orchestrator transcript.
"""

from __future__ import annotations

from agents import Agent

from .constants import DEFAULT_MODEL

research_agent = Agent(
    name="research_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You research a topic and return the key facts as a short bullet "
        "list. Facts only — no fluff, no conclusions."
    ),
)

writer_agent = Agent(
    name="writer_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You turn bullet-point facts into short, engaging prose. One tight "
        "paragraph unless asked otherwise."
    ),
)

critic_agent = Agent(
    name="critic_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You review a draft and return concrete improvement suggestions as a "
        "numbered list. Max 3 suggestions, be specific."
    ),
)


def create_orchestrator_agent() -> Agent:
    return Agent(
        name="orchestrator",
        model=DEFAULT_MODEL,
        instructions=(
            "You orchestrate a small content team. For writing requests: "
            "call research_topic for the facts, then write_prose to draft, "
            "then critique_draft to review, then produce the final version "
            "yourself incorporating the critique. For simple questions, "
            "answer directly without the team."
        ),
        tools=[
            research_agent.as_tool(
                tool_name="research_topic",
                tool_description="Research a topic and return key facts as bullets.",
            ),
            writer_agent.as_tool(
                tool_name="write_prose",
                tool_description="Turn bullet-point facts into short prose.",
            ),
            critic_agent.as_tool(
                tool_name="critique_draft",
                tool_description="Review a draft and suggest up to 3 improvements.",
            ),
        ],
    )
