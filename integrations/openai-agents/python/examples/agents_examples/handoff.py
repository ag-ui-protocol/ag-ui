"""Handoff — the SDK docs' own patterns from ``handoffs/``, wired for AG-UI.

Combines the two handoff shapes shown on that page in one triage agent:

* ``handoffs=[billing_agent]`` — passing an ``Agent`` directly (the
  "Basic usage" section). No customization; the SDK derives the
  ``transfer_to_billing_agent`` tool itself.
* ``handoffs=[handoff(agent=..., on_handoff=..., input_type=...)]`` — the
  "Handoff inputs" section: a Pydantic model the LLM fills in when it
  triggers the handoff, delivered to ``on_handoff`` before the specialist
  ever sees the conversation. Used here for escalation_agent so the reason
  is captured structurally instead of buried in free text.

Also uses ``RECOMMENDED_PROMPT_PREFIX`` (the "Recommended prompts" section)
on every agent that receives handoffs, since the docs call out that models
handle multi-agent handoffs more reliably with it in the instructions.

Exercises:

* ``translate_handoff_call_item`` / ``translate_handoff_output_item`` — the
  handoff shows up as an AG-UI tool call + result, same as any other tool.
  ``escalation_agent``'s structured input rides through as ordinary
  ``TOOL_CALL_ARGS`` JSON — no special-casing needed, since the translator
  dispatches on run-item type, not on whether the tool happens to be a
  handoff.
* ``translate_agent_updated_event`` — each hop emits ``STEP_FINISHED`` for
  the outgoing agent and ``STEP_STARTED`` for the incoming one, so the
  client can label which agent produced which message.
"""

from __future__ import annotations

from agents import Agent, RunContextWrapper, handoff
from agents.extensions.handoff_prompt import RECOMMENDED_PROMPT_PREFIX
from pydantic import BaseModel

from .constants import DEFAULT_MODEL

billing_agent = Agent(
    name="billing_agent",
    model=DEFAULT_MODEL,
    instructions=(
        f"{RECOMMENDED_PROMPT_PREFIX}\n"
        "You handle billing questions: invoices, charges, payment methods. "
        "Be precise and concise."
    ),
)

escalation_agent = Agent(
    name="escalation_agent",
    model=DEFAULT_MODEL,
    instructions=(
        f"{RECOMMENDED_PROMPT_PREFIX}\n"
        "You handle escalated issues that the triage agent couldn't resolve. "
        "Acknowledge the reason you were given and ask what outcome the "
        "customer is looking for."
    ),
)


class EscalationData(BaseModel):
    """Structured input the triage agent fills in when escalating."""

    reason: str


async def on_escalation_handoff(ctx: RunContextWrapper[None], input_data: EscalationData) -> None:
    print(f"Escalation agent called with reason: {input_data.reason}")


def create_handoff_agent() -> Agent:
    return Agent(
        name="triage_agent",
        model=DEFAULT_MODEL,
        instructions=(
            f"{RECOMMENDED_PROMPT_PREFIX}\n"
            "You triage customer support requests. Hand off to billing_agent "
            "for billing questions. For anything you can't resolve yourself, "
            "hand off to escalation_agent with a short reason. Handle "
            "anything else yourself."
        ),
        handoffs=[
            billing_agent,
            handoff(
                agent=escalation_agent,
                on_handoff=on_escalation_handoff,
                input_type=EscalationData,
            ),
        ],
    )
