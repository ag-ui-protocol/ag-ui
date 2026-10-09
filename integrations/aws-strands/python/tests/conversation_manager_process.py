"""Offline model fixture used by the real SDK/session restart regression."""

import asyncio
import sys
from pathlib import Path

from ag_ui.core import (
    AssistantMessage,
    FunctionCall,
    RunAgentInput,
    Tool,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands import Agent
from strands.agent.conversation_manager import SlidingWindowConversationManager
from strands.models.model import Model
from strands.session.file_session_manager import FileSessionManager

from ag_ui_strands import StrandsAgent, StrandsAgentConfig


class PickerModel(Model):
    """Replace only the remote provider; run the actual tool and session lifecycle."""

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, *args, **kwargs):
        raise NotImplementedError

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        picker = any(
            "pick a time" in block.get("text", "")
            for message in messages
            for block in message["content"]
        )
        answered = any(
            "toolResult" in block
            for message in messages
            for block in message["content"]
        )
        yield {"messageStart": {"role": "assistant"}}
        if picker and not answered:
            yield {
                "contentBlockStart": {
                    "start": {
                        "toolUse": {
                            "toolUseId": "picker-call",
                            "name": "scheduleTime",
                        }
                    }
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": "{}"}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
        else:
            yield {"contentBlockDelta": {"delta": {"text": "confirmed"}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "end_turn"}}


def run_input(thread, messages):
    return RunAgentInput(
        thread_id=thread,
        run_id="regression",
        state={},
        messages=messages,
        tools=[
            Tool(
                name="scheduleTime",
                description="Pick time",
                parameters={
                    "type": "object",
                    "properties": {},
                },
            )
        ],
        context=[],
        forwarded_props={},
    )


async def drive(adapter, thread, messages):
    events = [event async for event in adapter.run(run_input(thread, messages))]
    assert not [event for event in events if event.type == "RUN_ERROR"], events


async def run(store, phase):
    template = Agent(
        model=PickerModel(),
        callback_handler=None,
        conversation_manager=SlidingWindowConversationManager(window_size=4),
        state={"todos": [{"id": "saved-todo", "title": "Retain me"}]},
    )
    adapter = StrandsAgent(
        template,
        name="test",
        config=StrandsAgentConfig(
            session_manager_provider=lambda i: FileSessionManager(
                session_id=i.thread_id,
                storage_dir=str(store),
            ),
        ),
    )
    if phase == "seed":
        for index in range(4):
            await drive(
                adapter, "long", [UserMessage(id=str(index), content="ordinary turn")]
            )
        await drive(
            adapter, "picker", [UserMessage(id="question", content="pick a time")]
        )
    elif phase == "continue":
        await drive(
            adapter,
            "picker",
            [UserMessage(id="followup", content="remember the selected time")],
        )
    elif phase == "resume":
        await drive(
            adapter,
            "picker",
            [
                UserMessage(id="question", content="pick a time"),
                AssistantMessage(
                    id="call",
                    tool_calls=[
                        ToolCall(
                            id="picker-call",
                            function=FunctionCall(name="scheduleTime", arguments="{}"),
                        )
                    ],
                ),
                ToolMessage(
                    id="answer", tool_call_id="picker-call", content="Tomorrow 2:00 PM"
                ),
            ],
        )
    else:
        raise ValueError(phase)
    assert adapter._agents_by_thread["picker"].state.get("todos") == [
        {"id": "saved-todo", "title": "Retain me"},
    ]


if __name__ == "__main__":
    asyncio.run(run(Path(sys.argv[1]), sys.argv[2]))
