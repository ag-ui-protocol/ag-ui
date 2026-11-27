"""A model that follows a script, for suites that drive a real ``strands.Agent``.

The script is called once per model call with the conversation so far and
returns what the model does next: a string to say, or ``(tool, arguments)`` to
call a tool. Nothing leaves the process.
"""

from __future__ import annotations

import copy
import json
from typing import Any, Callable, Union

from ag_ui.core import RunAgentInput, UserMessage
from strands.models import Model

Step = Union[str, tuple]
Script = Callable[["ScriptedModel", list], Step]


class ScriptedModel(Model):
    def __init__(self, script: Script) -> None:
        self.script = script
        self.calls = 0
        self.seen_messages: list[list[dict[str, Any]]] = []
        self.seen_tool_names: list[list[str]] = []
        self.seen_system_prompts: list[Any] = []

    def get_config(self):
        return {}

    def update_config(self, **kwargs):
        pass

    async def structured_output(self, output_model, prompt, **kwargs):  # pragma: no cover
        if False:
            yield {}

    async def stream(self, messages, tool_specs=None, system_prompt=None, **kwargs):
        self.seen_messages.append(copy.deepcopy(messages))
        self.seen_tool_names.append([spec["name"] for spec in tool_specs or []])
        self.seen_system_prompts.append(system_prompt)
        step = self.script(self, messages)
        self.calls += 1
        yield {"messageStart": {"role": "assistant"}}
        if isinstance(step, tuple):
            name, arguments = step
            yield {
                "contentBlockStart": {
                    "start": {"toolUse": {"toolUseId": f"call-{self.calls}", "name": name}}
                }
            }
            yield {"contentBlockDelta": {"delta": {"toolUse": {"input": json.dumps(arguments)}}}}
            yield {"contentBlockStop": {}}
            yield {"messageStop": {"stopReason": "tool_use"}}
            return
        yield {"contentBlockDelta": {"delta": {"text": step}}}
        yield {"contentBlockStop": {}}
        yield {"messageStop": {"stopReason": "end_turn"}}


def has_tool_result(messages: list) -> bool:
    return any("toolResult" in block for message in messages for block in message["content"])


def last_tool_result_text(messages: list) -> str:
    for message in reversed(messages):
        for block in message["content"]:
            if "toolResult" in block:
                return json.dumps(block["toolResult"])
    return ""


def run_input(thread_id: str = "t1", run_id: str = "r1", **overrides: Any) -> RunAgentInput:
    fields: dict[str, Any] = {
        "thread_id": thread_id,
        "run_id": run_id,
        "state": {},
        "messages": [UserMessage(id="u1", content="go")],
        "tools": [],
        "context": [],
        "forwarded_props": {},
    }
    fields.update(overrides)
    return RunAgentInput(**fields)


async def collect(agent: Any, input_data: RunAgentInput) -> list:
    return [event async for event in agent.run(input_data)]
