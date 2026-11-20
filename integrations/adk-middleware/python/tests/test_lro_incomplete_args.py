"""Progressive LRO previews must not consume the completed call's arguments."""

import json

import pytest
from google.adk.events import Event
from google.genai import types

from ag_ui_adk import EventTranslator


@pytest.mark.asyncio
@pytest.mark.parametrize("tool_name", ["pieChart", "adk_request_confirmation"])
async def test_lro_waits_for_complete_arguments(tool_name):
    translator = EventTranslator()
    args = {
        "title": "é 東京",
        "data": [{"label": "A", "value": 10}],
        "nested": {"ok": True},
    }
    events = []
    for partial, call in [
        (True, types.FunctionCall(id="preview", name=tool_name, will_continue=True)),
        (False, types.FunctionCall(id="final", name=tool_name, args=args)),
        (False, types.FunctionCall(id="replay", name=tool_name, args=args)),
    ]:
        event = Event(
            author="assistant",
            partial=partial,
            content=types.Content(parts=[types.Part(function_call=call)]),
            long_running_tool_ids={call.id},
        )
        events.extend(
            [item async for item in translator.translate_lro_function_calls(event)]
        )
    assert [e.type.value for e in events] == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
    ]
    assert json.loads(events[1].delta) == args


@pytest.mark.asyncio
@pytest.mark.parametrize("frontend", [False, True])
@pytest.mark.parametrize("with_partials", [False, True])
async def test_complete_args_after_partials_or_single_event(frontend, with_partials):
    translator = EventTranslator()
    args = {"html": "<button>é 東京</button>", "data": [1, None, {"ok": True}]}
    calls = []
    if with_partials:
        calls.extend(
            [
                (
                    True,
                    types.FunctionCall(id="start", name="render", will_continue=True),
                ),
                (
                    True,
                    types.FunctionCall(
                        id="chunk",
                        name="render",
                        will_continue=True,
                        partial_args=[
                            {"json_path": "$.html", "string_value": "<button>é"}
                        ],
                    ),
                ),
            ]
        )
    calls.append((False, types.FunctionCall(id="final", name="render", args=args)))
    events = []
    for partial, call in calls:
        event = Event(
            author="assistant",
            partial=partial,
            content=types.Content(parts=[types.Part(function_call=call)]),
            long_running_tool_ids={call.id} if frontend else set(),
        )
        if frontend:
            events.extend(
                [e async for e in translator.translate_lro_function_calls(event)]
            )
        else:
            events.extend(
                [e async for e in translator.translate(event, "thread", "run")]
            )
    assert [e.type.value for e in events] == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
    ]
    assert json.loads(events[1].delta) == args


@pytest.mark.asyncio
async def test_parallel_same_name_preview_does_not_shift_replay_positions():
    translator = EventTranslator()
    preview = [
        types.FunctionCall(id="a-preview", name="chart", will_continue=True),
        types.FunctionCall(id="b-preview", name="chart", args={"title": "B"}),
    ]
    final = [
        types.FunctionCall(id="a-final", name="chart", args={"title": "A"}),
        types.FunctionCall(id="b-final", name="chart", args={"title": "B"}),
    ]
    events = []
    for partial, calls in [(True, preview), (False, final), (False, final)]:
        event = Event(
            author="assistant",
            partial=partial,
            content=types.Content(parts=[types.Part(function_call=c) for c in calls]),
            long_running_tool_ids={c.id for c in calls},
        )
        events.extend([e async for e in translator.translate_lro_function_calls(event)])
    assert [
        json.loads(e.delta) for e in events if e.type.value == "TOOL_CALL_ARGS"
    ] == [{"title": "A"}, {"title": "B"}]
    assert [e.type.value for e in events] == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
    ] * 2
