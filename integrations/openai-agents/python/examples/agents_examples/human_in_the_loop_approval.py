"""Tool approval — a *backend*-owned tool gated by the SDK's own approval API.

Unlike :mod:`human_in_the_loop` (a frontend-only tool with no server
implementation) and :mod:`backend_tool_rendering` (a server tool that always
runs), ``issue_refund`` here is real server-side logic that only runs after a
human approves it — the SDK's ``needs_approval=True`` mechanism
(``agents.tool.function_tool``), not an AG-UI concept.

Mechanically: when the model calls ``issue_refund``, the SDK stops the run
*before* the tool body executes and surfaces a ``ToolApprovalItem`` on
``result.interruptions``. That only becomes known once the stream is fully
drained — there is no mid-stream event for it — so it can't go through the
normal per-item translator dispatch the way ``MCPApprovalRequestItem`` does.
The run loop (``server.py`` / ``translator_server.py``) checks
``result.interruptions`` right after ``to_agui()`` finishes, and if any are
pending:

1. Serializes the paused run via ``result.to_state()`` and keeps it
   server-side, keyed by ``thread_id`` (an in-memory dict here — a real app
   would use a session store; this survives one process, not a restart).
2. Emits one ``CustomEvent(name="approval_request")`` carrying every
   interruption, as ``to_agui()``'s ``end_custom_event`` — right before
   ``RUN_FINISHED``, not after it. The client drops anything that arrives
   once a run is marked finished, so this has to land before that event,
   which means draining the raw SDK stream by hand first (interruptions
   aren't known until it's fully drained) instead of handing ``result``
   straight to ``to_agui()``.

The frontend renders Approve/Reject; either choice comes back as the next
``RunAgentInput.forwarded_props["approval"]`` (``{"call_id", "approve"}``).
The run loop looks up the stored state, calls ``state.approve()`` /
``state.reject()``, and resumes with ``Runner.run_streamed(agent, state)``
instead of starting fresh from ``translated.messages``.
"""

from __future__ import annotations

from agents import Agent, function_tool

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
