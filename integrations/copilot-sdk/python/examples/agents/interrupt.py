"""``schedule_meeting`` has no handler, so the runtime suspends it; because it is
listed under ``interrupts``, the run finishes with an interrupt outcome instead
of a plain handoff. The Dojo's picker answers it, and the mapper below turns
that answer into the tool result the model reads when the call resumes."""

from typing import Any

from ag_ui_copilot_sdk import AGUITool, CopilotAgent

from .base import define_agent

INSTRUCTIONS = """You are a scheduling assistant.

Whenever the user asks you to book a call or schedule a meeting, you MUST call
the `schedule_meeting` tool. Pass a short `topic` describing the purpose and, if
known, an `attendee` describing who the meeting is with.

The tool pauses execution and shows the user a time picker. Once it resumes with
their choice, briefly confirm whether the meeting was scheduled and at what
time, or note that the user cancelled. Do not ask for approval yourself: always
call the tool and let the picker handle the decision. Keep responses short and
friendly.

Never claim a meeting is scheduled unless the tool result says so."""


def on_schedule_meeting(payload: Any, args: dict[str, Any]) -> str:
    topic = args.get("topic", "")
    answer = payload if isinstance(payload, dict) else {}
    if answer.get("cancelled"):
        return f"User cancelled. Meeting NOT scheduled: {topic}"
    label = answer.get("chosen_label") or answer.get("chosen_time")
    if not label:
        return f"User did not pick a time. Meeting NOT scheduled: {topic}"
    return f"Meeting scheduled for {label}: {topic}"


def create_interrupt_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="interrupt",
        instructions=INSTRUCTIONS,
        tools=[
            AGUITool(
                name="schedule_meeting",
                description="Ask the user to pick a meeting time, then confirm what was scheduled.",
                parameters={
                    "type": "object",
                    "properties": {
                        "topic": {
                            "type": "string",
                            "description": "Short description of the meeting purpose.",
                        },
                        "attendee": {
                            "type": "string",
                            "description": "Who the meeting is with, if known.",
                        },
                    },
                    "required": ["topic"],
                },
            )
        ],
        interrupts={"schedule_meeting": on_schedule_meeting},
    )
