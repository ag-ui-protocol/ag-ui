"""Tool approval — a *backend*-owned tool gated by the SDK's own approval API.

Unlike :mod:`human_in_the_loop` (a frontend-only tool with no server
implementation) and :mod:`backend_tool_rendering` (a server tool that always
runs), ``issue_refund`` here is real server-side logic that only runs after a
human approves it — the SDK's ``needs_approval=True`` mechanism.

When the model calls ``issue_refund``, the SDK pauses the run before the tool
body executes. ``OpenAIAgentsAgent`` ends that AG-UI run with an interrupt
(``RUN_FINISHED.outcome = {"type": "interrupt"}``): one per paused call, with
the call's id, ``metadata.tool_name`` / ``metadata.tool_input`` for the page
to show, and an ``{"approved": boolean}`` response schema. The page renders
Approve / Reject with CopilotKit's ``useInterrupt`` and resolves the
interrupt, which sends the decision as the next request's ``resume`` entry.

The next request answers the paused call before the model runs: approved, the
tool runs and its output goes to the model; anything else, it does not run.
Nothing is stored between the two requests — the paused call lives in the
conversation history the client sends back.
"""

from __future__ import annotations

from agents import Agent, function_tool
from fastapi import FastAPI

from ag_ui_openai_agents import OpenAIAgentsAgent, add_openai_agents_fastapi_endpoint
from .constants import DEFAULT_MODEL

# Fake order book — good enough to make "approved" visibly do something.
_ORDERS: dict[str, dict] = {
    "ORD-1001": {"amount": 49.99, "status": "paid"},
    "ORD-1002": {"amount": 129.50, "status": "paid"},
}


@function_tool(needs_approval=True)
def issue_refund(order_id: str) -> str:
    """Issue a full refund for an order. Requires human approval before running."""
    order = _ORDERS.get(order_id)
    if order is None:
        return f"No such order: {order_id}"
    order["status"] = "refunded"
    return f"Refunded ${order['amount']:.2f} for {order_id}."


def create_human_in_the_loop_approval_agent() -> Agent:
    return Agent(
        name="refund_assistant",
        model=DEFAULT_MODEL,
        instructions=(
            "You are a customer support assistant. When the user asks for a "
            "refund on an order, call issue_refund with that order id. "
            "Known orders: ORD-1001 ($49.99), ORD-1002 ($129.50). Don't ask "
            "for confirmation yourself — the approval happens outside the "
            "conversation before the tool runs."
        ),
        tools=[issue_refund],
    )


agent = OpenAIAgentsAgent(
    create_human_in_the_loop_approval_agent(), name="human_in_the_loop_approval"
)
app = FastAPI(title="Human in the loop approval AG-UI demo")
add_openai_agents_fastapi_endpoint(app, agent, "/")
