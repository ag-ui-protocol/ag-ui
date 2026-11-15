"""Deterministic scripted model and agent builders for HITL / interrupt tests.

The live HITL confirmation test skips under LLMock (it never emits a tool
call), so these tests drive ADK with a scripted ``BaseLlm`` instead.
"""

from __future__ import annotations

import json
from typing import Any, AsyncGenerator, Dict, List, Optional

from pydantic import Field

from ag_ui.core import BaseEvent, EventType, RunAgentInput
from ag_ui_adk import ADKAgent
from google.adk.agents.llm_agent import LlmAgent
from google.adk.apps import App, ResumabilityConfig
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.sessions import InMemorySessionService
from google.genai import types

RC_TOOL_NAME = "adk_request_confirmation"


class ScriptedLlm(BaseLlm):
    """Turn 1 calls ``first_call`` (name, args), or every call in ``first_calls``;
    every later turn replies with text.

    Every request's final content is recorded in ``last_contents`` so a test can
    inspect exactly what reached the model on each turn.
    """

    first_call: Optional[Dict[str, Any]] = None
    first_calls: Optional[List[Dict[str, Any]]] = None
    turn_count: int = 0
    last_contents: List[Any] = Field(default_factory=list)

    async def generate_content_async(
        self, llm_request, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.turn_count += 1
        contents = getattr(llm_request, "contents", None) or []
        self.last_contents.append(contents[-1] if contents else None)
        calls = self.first_calls or ([self.first_call] if self.first_call else [])
        if self.turn_count == 1 and calls:
            yield LlmResponse(
                content=types.Content(
                    role="model",
                    parts=[
                        types.Part(
                            function_call=types.FunctionCall(
                                name=call["name"], args=call.get("args", {})
                            )
                        )
                        for call in calls
                    ],
                ),
                partial=False,
                turn_complete=True,
            )
        else:
            yield LlmResponse(
                content=types.Content(
                    role="model", parts=[types.Part(text="Done.")]
                ),
                partial=False,
                turn_complete=True,
            )


class ConfirmationTool:
    """A backend tool gated by ``tool_context.request_confirmation``.

    Counts real executions and records every ``ToolConfirmation`` it is resumed
    with, so tests can assert "executed exactly once" by counting.
    """

    def __init__(self) -> None:
        self.executed = 0
        self.confirmations: List[Any] = []

        def dangerous_action(target: str, tool_context) -> dict:
            """A backend tool gated by HITL confirmation."""
            confirmation = tool_context.tool_confirmation
            if confirmation is None:
                tool_context.request_confirmation(
                    hint=f"Confirm dangerous_action on target='{target}'?"
                )
                return {"status": "awaiting_confirmation", "target": target}
            self.confirmations.append(confirmation)
            if not confirmation.confirmed:
                return {"status": "rejected", "target": target}
            self.executed += 1
            return {"status": "executed", "target": target}

        self.fn = dangerous_action


def build_confirmation_agent(
    tool: ConfirmationTool, *, targets: tuple = ("foo",), **agent_kwargs: Any
) -> tuple[ADKAgent, ScriptedLlm]:
    llm = ScriptedLlm(
        model="scripted",
        first_calls=[
            {"name": "dangerous_action", "args": {"target": target}} for target in targets
        ],
    )
    agent = ADKAgent.from_app(
        App(
            name="confirmation_app",
            root_agent=LlmAgent(
                name="confirmation_agent", model=llm, tools=[tool.fn]
            ),
            resumability_config=ResumabilityConfig(is_resumable=True),
        ),
        user_id="test_user",
        session_service=agent_kwargs.pop("session_service", None) or InMemorySessionService(),
        **agent_kwargs,
    )
    return agent, llm


def run_input(thread_id: str, run_id: str, messages, **kwargs) -> RunAgentInput:
    return RunAgentInput(
        thread_id=thread_id,
        run_id=run_id,
        messages=messages,
        tools=kwargs.pop("tools", []),
        context=[],
        state=kwargs.pop("state", {}),
        forwarded_props={},
        **kwargs,
    )


async def collect(agent: ADKAgent, input_: RunAgentInput) -> List[BaseEvent]:
    return [event async for event in agent.run(input_)]


def tool_call(events: List[BaseEvent], name: str) -> tuple[Optional[str], str]:
    """Return (tool_call_id, concatenated args) of the first call named ``name``."""
    call_id, args, inside = None, "", False
    for event in events:
        if event.type == EventType.TOOL_CALL_START:
            inside = event.tool_call_name == name and call_id is None
            if inside:
                call_id = event.tool_call_id
        elif event.type == EventType.TOOL_CALL_ARGS and inside:
            args += event.delta
        elif event.type == EventType.TOOL_CALL_END:
            inside = False
    return call_id, args


def run_finished(events: List[BaseEvent]):
    finished = [e for e in events if e.type == EventType.RUN_FINISHED]
    assert len(finished) == 1, [e.type for e in events]
    assert events[-1] is finished[0], "RUN_FINISHED must be the last event"
    return finished[0]


def content_text(content: Any) -> str:
    parts = getattr(content, "parts", None) or []
    return "".join(getattr(p, "text", None) or "" for p in parts)


def args_json(args: str) -> dict:
    return json.loads(args) if args else {}
