"""Interrupt: a server tool pauses itself until the user picks a meeting time.

`schedule_meeting` runs on the server and, before it books anything, calls the
adapter's `experimental_interrupt()`. That parks the tool inside the harness turn and ends
the AG-UI run with `RUN_FINISHED` carrying an interrupt outcome. The dojo's
shared interrupt page renders a time picker from the interrupt and answers with
`RunAgentInput.resume`; the next run hands that answer back to the same
`experimental_interrupt()` call, and the tool carries on from there.

The page reads the question from `metadata.reason` (the shape AWS Strands
publishes) and resolves with `{chosen_time, chosen_label}`, or with
`{cancelled: true}` when the user cancels.
"""

from __future__ import annotations

from ag_ui_antigravity import experimental_interrupt

from ._common import build, chat_only_capabilities


async def schedule_meeting(topic: str, attendee: str) -> str:
    """Schedules a meeting. The user picks the time before it is booked.

    Args:
      topic: What the meeting is about, e.g. "Intro call to discuss pricing".
      attendee: Who the meeting is with, e.g. "the sales team".
    """
    answer = await experimental_interrupt(
        "schedule_meeting",
        message=f"Pick a time for {topic}",
        metadata={"reason": {"topic": topic, "attendee": attendee}},
    )
    if answer.status == "abandoned":
        return (
            f"The user moved on without picking a time. Meeting NOT scheduled: "
            f"{topic}"
        )
    payload = answer.payload if isinstance(answer.payload, dict) else {}
    label = payload.get("chosen_label")
    if not answer.resolved or payload.get("cancelled") or not label:
        return f"User cancelled. Meeting NOT scheduled: {topic}"
    return f"Meeting scheduled for {label}: {topic}"


agent = build(
    capabilities=chat_only_capabilities(),
    tools=[schedule_meeting],
    system_instructions=(
        "You help the user book meetings. To book one, call schedule_meeting "
        "with a short topic and the attendee; it asks the user for a time "
        "itself, so never ask for one yourself. Then tell the user what the "
        "tool reported: the time it was booked for, or that nothing was "
        "scheduled."
    ),
)
