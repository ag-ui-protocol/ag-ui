"""Handoff — multi-agent triage using the SDK's native ``handoffs=``.

The triage agent hands the conversation to a specialist via the SDK's
built-in handoff mechanism (no custom routing code). Exercises:

* ``translate_handoff_call_item`` / ``translate_handoff_output_item`` — the
  handoff shows up as a AG-UI tool call + result, same as any other tool.
* ``translate_agent_updated_event`` — each hop emits ``STEP_FINISHED`` for
  the outgoing agent and ``STEP_STARTED`` for the incoming one, so the
  client can label which agent produced which message.
"""

from __future__ import annotations

from agents import Agent

from .constants import DEFAULT_MODEL

billing_agent = Agent(
    name="billing_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You handle billing questions: invoices, charges, payment methods. "
        "Be precise and concise."
    ),
)

refund_agent = Agent(
    name="refund_agent",
    model=DEFAULT_MODEL,
    instructions=(
        "You handle refund requests. Ask for the order id if missing, then "
        "confirm the refund amount and timeline."
    ),
)


def create_handoff_agent() -> Agent:
    return Agent(
        name="triage_agent",
        model=DEFAULT_MODEL,
        instructions=(
            "You triage customer support requests. Hand off to billing_agent "
            "for billing questions, or refund_agent for refund requests. "
            "Handle anything else yourself."
        ),
        handoffs=[billing_agent, refund_agent],
    )
