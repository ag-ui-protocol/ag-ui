"""Interrupt feature.

``schedule_meeting`` pauses itself. On its first call it asks for a tool
confirmation through ``tool_context.request_confirmation(...)``, which makes ADK
emit a long-running ``adk_request_confirmation`` call and pause the invocation.
The middleware finishes that run with ``RUN_FINISHED`` carrying
``outcome.type == "interrupt"``, and the dojo's interrupt page renders its time
picker from the confirmation payload.

Resuming hands the user's answer back as the tool confirmation, and ADK re-runs
the same tool with ``tool_context.tool_confirmation`` set. A picked slot arrives
as ``confirmed=True`` with ``{"chosen_time", "chosen_label"}`` in the payload.
The picker's Cancel button resolves with ``{"cancelled": True}``, and a cancelled
resume entry arrives as ``confirmed=False``.

``ResumabilityConfig`` makes ADK persist the paused call so the confirmation can
be matched back to it on the next run.
"""

from __future__ import annotations

from collections.abc import Mapping

from fastapi import FastAPI
from ag_ui_adk import ADKAgent, add_adk_fastapi_endpoint
from google.adk.agents import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.tools import ToolContext


def schedule_meeting(topic: str, tool_context: ToolContext, attendee: str = "") -> str:
    """Ask the user to pick a meeting time, then confirm what was scheduled.

    Args:
        topic: Short description of the meeting purpose.
        attendee: Who the meeting is with, if known.
    """
    confirmation = tool_context.tool_confirmation
    if confirmation is None:
        tool_context.request_confirmation(
            hint=f"Pick a time for: {topic}",
            payload={"topic": topic, "attendee": attendee},
        )
        return "Waiting for the user to pick a time."

    # The payload is whatever the client resolved with, so it need not be a
    # mapping at all. Checked rather than assumed.
    payload = confirmation.payload if isinstance(confirmation.payload, Mapping) else {}
    if not confirmation.confirmed or payload.get("cancelled"):
        return f"User cancelled. Meeting NOT scheduled: {topic}"

    label = payload.get("chosen_label") or payload.get("chosen_time")
    if not label:
        return f"User did not pick a time. Meeting NOT scheduled: {topic}"
    return f"Meeting scheduled for {label}: {topic}"


interrupt_agent = LlmAgent(
    model="gemini-2.5-flash",
    name="interrupt_agent",
    instruction="""You are a scheduling assistant.

Whenever the user asks you to book a call or schedule a meeting, you MUST call
the `schedule_meeting` tool. Pass a short `topic` describing the purpose and, if
known, an `attendee` describing who the meeting is with.

The tool pauses and shows the user a time picker. Once it resumes with their
choice, briefly confirm whether the meeting was scheduled and at what time, or
tell the user you did not schedule anything because they cancelled. Do not ask
for approval yourself: always call the tool and let the picker handle the
decision. Keep responses short and friendly.

Only report a meeting as booked when the schedule_meeting result says so.""",
    tools=[schedule_meeting],
)

adk_app = App(
    name="interrupt_app",
    root_agent=interrupt_agent,
    resumability_config=ResumabilityConfig(is_resumable=True),
)

adk_interrupt_agent = ADKAgent.from_app(
    adk_app,
    user_id="demo_user",
    session_timeout_seconds=3600,
    use_in_memory_services=True,
    # Opt in to ending the paused run with RUN_FINISHED.outcome = interrupt.
    emit_interrupt_outcome=True,
)

app = FastAPI(title="ADK Middleware Interrupt")

add_adk_fastapi_endpoint(app, adk_interrupt_agent, path="/")
