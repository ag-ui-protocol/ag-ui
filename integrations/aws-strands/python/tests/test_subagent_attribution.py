"""Tests for ``subagent_visibility``: AG-UI subagent events for agents-as-tools.

Every test drives REAL ``strands.Agent`` instances (parent and sub-agents)
over the scripted Bedrock-shaped model from ``test_raw_and_inner_agent_events``,
so the inner streams come out of Strands' own event loop.
"""

from __future__ import annotations

from typing import Any, AsyncIterable, Optional

import pytest
from ag_ui.core import (
    AGUI_METADATA_KEY,
    AssistantMessage,
    EventType,
    FunctionCall,
    RunAgentInput,
    ToolCall,
    ToolMessage,
    UserMessage,
)
from strands import Agent as StrandsAgentCore
from strands import tool
from strands.types.tools import ToolContext

from ag_ui_strands.a2ui_tool import A2UI_STREAM_KEY
from ag_ui_strands.agent import StrandsAgent, _forward_inner_agent_events
from ag_ui_strands.config import StrandsAgentConfig, ToolBehavior
from ag_ui_strands.subagents import (
    SUBAGENT_ABANDONED_CODE,
    SUBAGENT_ERROR_CODE,
    SubagentRuns,
    strip_subagent_messages,
)

from .test_raw_and_inner_agent_events import (
    ScriptedModel,
    _assert_stream_encodes,
    _nested_agent,
    _parallel_agent_as_tool_parent,
    _Sequencer,
    _template_agent,
    _text_turn,
    _tool_turn,
)

SUBAGENT_LIFECYCLE = {
    EventType.SUBAGENT_STARTED,
    EventType.SUBAGENT_FINISHED,
    EventType.SUBAGENT_ERROR,
}


class RecordingModel(ScriptedModel):
    """A scripted model that also records the history it was shown."""

    def __init__(self, turns: list[list[dict]]) -> None:
        super().__init__(turns)
        self.seen: list[Any] = []

    async def stream(
        self,
        messages: Any,
        tool_specs: Optional[list] = None,
        system_prompt: Optional[str] = None,
        **kwargs: Any,
    ) -> AsyncIterable[dict]:
        self.seen.append(list(messages))
        async for event in super().stream(messages, tool_specs, system_prompt, **kwargs):
            yield event


def _wrap(
    strands_agent: StrandsAgentCore,
    visibility: str | None = None,
    thread_id: str = "t1",
) -> StrandsAgent:
    config = (
        StrandsAgentConfig()
        if visibility is None
        else StrandsAgentConfig(subagent_visibility=visibility)
    )
    agent = StrandsAgent(_template_agent(), name="test-agent", config=config)
    agent._agents_by_thread[thread_id] = strands_agent
    return agent


def _input(messages: list | None = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="t1",
        run_id="r1",
        state={},
        messages=messages
        or [UserMessage(id="u1", role="user", content="hello")],
        tools=[],
        context=[],
        forwarded_props={},
    )


async def _collect(agent: StrandsAgent, messages: list | None = None) -> list:
    events = [event async for event in agent.run(_input(messages))]
    _assert_stream_encodes(events)
    return events


def _index(events: list, predicate) -> int:
    return next(i for i, e in enumerate(events) if predicate(e))


def _of(events: list, event_type) -> list:
    return [e for e in events if e.type == event_type]


def _as_tool_agent() -> StrandsAgentCore:
    """Parent whose tool is a real ``Agent.as_tool()`` sub-agent."""

    @tool
    def lookup_weather(city: str) -> str:
        """Look up the weather for a city."""
        return f"sunny in {city}"

    researcher = StrandsAgentCore(
        name="researcher",
        description="Researches anything.",
        model=ScriptedModel(
            [
                _tool_turn("inner_1", "lookup_weather", '{"city": "Paris"}'),
                _text_turn("Paris is sunny."),
            ]
        ),
        tools=[lookup_weather],
        callback_handler=None,
    )
    return StrandsAgentCore(
        model=ScriptedModel(
            [
                _tool_turn("parent_1", "researcher", '{"input": "weather"}'),
                _text_turn("Done."),
            ]
        ),
        tools=[researcher.as_tool()],
        callback_handler=None,
    )


# ---------------------------------------------------------------------------
# Default: inline, unchanged
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize("visibility", [None, "inline"])
async def test_inline_emits_no_subagent_surface(visibility):
    events = await _collect(_wrap(_nested_agent(), visibility))

    assert not [e for e in events if e.type in SUBAGENT_LIFECYCLE]
    assert not [e for e in events if getattr(e, "subagent_run_id", None)]
    for snapshot in _of(events, EventType.MESSAGES_SNAPSHOT):
        assert not [m for m in snapshot.messages if m.subagent_run_id]
    # The pre-existing inline forwarding still reaches the wire.
    assert [
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == "lookup_weather"
    ]


# ---------------------------------------------------------------------------
# Attributed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "build, parent_id, name",
    [
        (_nested_agent, "tooluse_parent_1", "research_agent"),
        (_as_tool_agent, "parent_1", "researcher"),
    ],
    ids=["generator-tool", "as_tool"],
)
async def test_attributed_announces_streams_and_closes_the_subagent(
    build, parent_id, name
):
    events = await _collect(_wrap(build(), "attributed"))

    (started,) = _of(events, EventType.SUBAGENT_STARTED)
    assert started.subagent_run_id == parent_id
    assert started.parent_tool_call_id == parent_id
    assert started.name == name
    assert started.parent_subagent_run_id is None
    if name == "researcher":
        assert started.description == "Researches anything."

    (finished,) = _of(events, EventType.SUBAGENT_FINISHED)
    assert finished.subagent_run_id == parent_id
    assert finished.outcome.type == "success"
    assert "Paris is sunny." in str(finished.result)

    # The sub-agent's tool call and its text are attributed to it...
    inner_start = next(
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == "lookup_weather"
    )
    assert inner_start.subagent_run_id == parent_id
    assert inner_start.parent_message_id
    inner_text = [
        e for e in _of(events, EventType.TEXT_MESSAGE_CONTENT) if e.subagent_run_id
    ]
    assert "".join(e.delta for e in inner_text) == "Paris is sunny."
    assert {e.subagent_run_id for e in inner_text} == {parent_id}

    # ...while the parent's own work stays untagged.
    parent_start = next(
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == name
    )
    assert parent_start.subagent_run_id is None
    parent_text = [
        e for e in _of(events, EventType.TEXT_MESSAGE_CONTENT) if not e.subagent_run_id
    ]
    assert "".join(e.delta for e in parent_text) == "Done."

    # Order: spawning call, start, sub-agent work, finish, spawning result.
    i_parent_start = events.index(parent_start)
    i_started = events.index(started)
    i_inner = events.index(inner_start)
    i_finished = events.index(finished)
    i_result = _index(
        events,
        lambda e: e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id == parent_id,
    )
    assert i_parent_start < i_started < i_inner < i_finished < i_result

    # Every attributed text stream opened is closed under the same owner.
    opened = {
        e.message_id: e.subagent_run_id
        for e in _of(events, EventType.TEXT_MESSAGE_START)
    }
    closed = {
        e.message_id: e.subagent_run_id
        for e in _of(events, EventType.TEXT_MESSAGE_END)
    }
    assert opened == closed


@pytest.mark.asyncio
async def test_attributed_snapshot_carries_the_subagents_messages():
    events = await _collect(_wrap(_nested_agent(), "attributed"))
    final = _of(events, EventType.MESSAGES_SNAPSHOT)[-1].messages
    roles = [(m.role, m.subagent_run_id) for m in final]

    parent_call = next(
        i
        for i, m in enumerate(final)
        if m.role == "assistant"
        and m.tool_calls
        and m.tool_calls[0].id == "tooluse_parent_1"
    )
    parent_result = next(
        i
        for i, m in enumerate(final)
        if m.role == "tool" and m.tool_call_id == "tooluse_parent_1"
    )
    between = final[parent_call + 1 : parent_result]
    assert between, f"no sub-agent messages between call and result: {roles}"
    assert {m.subagent_run_id for m in between} == {"tooluse_parent_1"}

    call_msg = next(m for m in between if m.role == "assistant" and m.tool_calls)
    (inner_call,) = call_msg.tool_calls
    assert inner_call.function.name == "lookup_weather"
    assert inner_call.function.arguments == '{"city": "Paris"}'
    assert any(
        m.role == "tool" and m.tool_call_id == inner_call.id for m in between
    )
    assert any(
        m.role == "assistant" and m.content == "Paris is sunny." for m in between
    )

    # The live tool call hangs off the same message the snapshot names.
    inner_start = next(
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == "lookup_weather"
    )
    assert inner_start.parent_message_id == call_msg.id


@pytest.mark.asyncio
async def test_attributed_reports_a_failed_subagent_as_subagent_error():
    inner = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Working on it...")]),
        callback_handler=None,
    )

    @tool
    async def flaky_agent(query: str):
        """Delegate to a sub-agent that fails after streaming."""
        async for event in inner.stream_async(query):
            yield event
        raise RuntimeError("sub-agent exploded")

    parent = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("parent_x", "flaky_agent", '{"query": "q"}'), _text_turn("Sorry.")]
        ),
        tools=[flaky_agent],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "attributed"))

    assert not _of(events, EventType.SUBAGENT_FINISHED)
    (error,) = _of(events, EventType.SUBAGENT_ERROR)
    assert error.subagent_run_id == "parent_x"
    assert error.code == "STRANDS_SUBAGENT_ERROR"
    assert "sub-agent exploded" in error.message
    assert events.index(error) < _index(
        events,
        lambda e: e.type == EventType.TOOL_CALL_RESULT and e.tool_call_id == "parent_x",
    )
    assert events[-1].type == EventType.RUN_FINISHED


@pytest.mark.asyncio
async def test_attributed_nests_a_subagent_of_a_subagent():
    @tool
    def lookup_weather(city: str) -> str:
        """Look up the weather for a city."""
        return f"sunny in {city}"

    leaf = StrandsAgentCore(
        name="leaf",
        description="Looks things up.",
        model=ScriptedModel(
            [
                _tool_turn("leaf_1", "lookup_weather", '{"city": "Rome"}'),
                _text_turn("Rome is sunny."),
            ]
        ),
        tools=[lookup_weather],
        callback_handler=None,
    )
    middle = StrandsAgentCore(
        name="middle",
        description="Delegates to the leaf.",
        model=ScriptedModel(
            [_tool_turn("mid_1", "leaf", '{"input": "rome"}'), _text_turn("Leaf says sunny.")]
        ),
        tools=[leaf.as_tool()],
        callback_handler=None,
    )
    parent = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("top_1", "middle", '{"input": "go"}'), _text_turn("All done.")]
        ),
        tools=[middle.as_tool()],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "attributed"))

    started = {e.name: e for e in _of(events, EventType.SUBAGENT_STARTED)}
    assert set(started) == {"middle", "leaf"}
    assert started["middle"].subagent_run_id == "top_1"
    assert started["middle"].parent_subagent_run_id is None
    leaf_run = started["leaf"].subagent_run_id
    assert leaf_run == "top_1::mid_1"
    assert started["leaf"].parent_subagent_run_id == "top_1"
    assert started["leaf"].parent_tool_call_id == leaf_run

    # The spawning call of the leaf is the middle agent's own (attributed) call.
    spawning = next(
        e for e in _of(events, EventType.TOOL_CALL_START) if e.tool_call_id == leaf_run
    )
    assert spawning.tool_call_name == "leaf"
    assert spawning.subagent_run_id == "top_1"

    leaf_call = next(
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == "lookup_weather"
    )
    assert leaf_call.subagent_run_id == leaf_run
    assert leaf_call.tool_call_id == "top_1::mid_1::leaf_1"
    leaf_text = "".join(
        e.delta
        for e in _of(events, EventType.TEXT_MESSAGE_CONTENT)
        if e.subagent_run_id == leaf_run
    )
    assert leaf_text == "Rome is sunny."

    finished = [e.subagent_run_id for e in _of(events, EventType.SUBAGENT_FINISHED)]
    assert finished == [leaf_run, "top_1"]


@pytest.mark.asyncio
async def test_attributed_keeps_parallel_subagents_apart():
    sequencer = _Sequencer(["A:tooluse#1", "B:stop#1", "A:tooluse#2", "A:stop#1"])
    events = await _collect(
        _wrap(_parallel_agent_as_tool_parent(sequencer), "attributed")
    )

    started = {e.subagent_run_id for e in _of(events, EventType.SUBAGENT_STARTED)}
    assert started == {"parent_a", "parent_b"}
    finished = {e.subagent_run_id for e in _of(events, EventType.SUBAGENT_FINISHED)}
    assert finished == {"parent_a", "parent_b"}

    inner = next(
        e
        for e in _of(events, EventType.TOOL_CALL_START)
        if e.tool_call_name == "lookup_weather"
    )
    assert inner.subagent_run_id == "parent_a"
    text_by_run: dict[str, str] = {}
    for e in _of(events, EventType.TEXT_MESSAGE_CONTENT):
        if e.subagent_run_id:
            text_by_run[e.subagent_run_id] = text_by_run.get(e.subagent_run_id, "") + e.delta
    assert text_by_run == {"parent_a": "Paris is sunny.", "parent_b": "AMZN is up."}


# ---------------------------------------------------------------------------
# Hidden
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hidden_shows_only_the_spawning_call_and_its_result():
    events = await _collect(_wrap(_nested_agent(), "hidden"))

    assert not [e for e in events if e.type in SUBAGENT_LIFECYCLE]
    names = [e.tool_call_name for e in _of(events, EventType.TOOL_CALL_START)]
    assert names == ["research_agent"]
    results = [e.tool_call_id for e in _of(events, EventType.TOOL_CALL_RESULT)]
    assert results == ["tooluse_parent_1"]
    text = "".join(e.delta for e in _of(events, EventType.TEXT_MESSAGE_CONTENT))
    assert text == "Done."


# ---------------------------------------------------------------------------
# Inbound: sub-agent messages never reach the parent model
# ---------------------------------------------------------------------------


def _history_with_subagent_work() -> list:
    """A prior turn as two clients send it back: attributed, and flattened."""
    return [
        UserMessage(id="u1", role="user", content="weather?"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="p1",
                    type="function",
                    function=FunctionCall(name="research_agent", arguments="{}"),
                ),
                # assistant-ui flattens nested calls onto the spawning message.
                ToolCall(
                    id="p1::i1",
                    type="function",
                    function=FunctionCall(name="lookup_weather", arguments="{}"),
                ),
            ],
        ),
        ToolMessage(id="t_inner", role="tool", content="sunny", tool_call_id="p1::i1"),
        AssistantMessage(
            id="s1",
            role="assistant",
            content="Paris is sunny.",
            subagent_run_id="p1",
        ),
        ToolMessage(id="t1", role="tool", content="Paris is sunny.", tool_call_id="p1"),
        AssistantMessage(id="a2", role="assistant", content="It is sunny."),
        UserMessage(id="u2", role="user", content="thanks"),
    ]


def test_strip_subagent_messages_removes_both_shapes():
    kept = strip_subagent_messages(_history_with_subagent_work())

    assert [m.id for m in kept] == ["u1", "a1", "t1", "a2", "u2"]
    assert [tc.id for tc in kept[1].tool_calls] == ["p1"]


def test_strip_subagent_messages_keeps_unrelated_ids_with_the_separator():
    history = [
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(
                    id="ns::call",
                    type="function",
                    function=FunctionCall(name="t", arguments="{}"),
                )
            ],
        ),
        ToolMessage(id="t1", role="tool", content="x", tool_call_id="ns::call"),
    ]
    assert strip_subagent_messages(history) == history


@pytest.mark.asyncio
async def test_attributed_echoes_subagent_history_but_hides_it_from_the_parent():
    model = RecordingModel([_text_turn("You're welcome.")])
    parent = StrandsAgentCore(model=model, callback_handler=None)

    events = await _collect(
        _wrap(parent, "attributed"), messages=_history_with_subagent_work()
    )

    shown = repr(model.seen[-1])
    assert "Paris is sunny." in shown  # the spawning call's result is the parent's
    assert "p1::i1" not in shown
    assert "lookup_weather" not in shown
    assert shown.count("Paris is sunny.") == 1

    first_snapshot = _of(events, EventType.MESSAGES_SNAPSHOT)[0].messages
    by_id = {m.id: m for m in first_snapshot}
    assert by_id["s1"].subagent_run_id == "p1"
    assert [tc.id for tc in by_id["a1"].tool_calls] == ["p1", "p1::i1"]
    assert "t_inner" in by_id


@pytest.mark.asyncio
async def test_inline_leaves_client_history_as_it_was():
    model = RecordingModel([_text_turn("You're welcome.")])
    parent = StrandsAgentCore(model=model, callback_handler=None)

    events = await _collect(
        _wrap(parent, "inline"), messages=_history_with_subagent_work()
    )

    assert "p1::i1" in repr(model.seen[-1])
    first_snapshot = _of(events, EventType.MESSAGES_SNAPSHOT)[0].messages
    assert not [m for m in first_snapshot if m.subagent_run_id]


# ---------------------------------------------------------------------------
# Bookkeeping
# ---------------------------------------------------------------------------


async def _no_tool_calls(*_args: Any):
    return
    yield  # pragma: no cover


@pytest.mark.asyncio
async def test_close_all_closes_open_runs_deepest_first():
    runs = SubagentRuns("attributed", _no_tool_calls)
    seen: dict = {}
    parent = {"toolUseId": "a", "name": "a"}

    def nested(data: dict) -> dict:
        return {"tool_stream_event": {"tool_use": {"toolUseId": "b", "name": "b"}, "data": data}}

    for payload in (
        {"init_event_loop": True},
        nested({"init_event_loop": True}),
        nested({"data": "hi"}),
    ):
        _ = [e async for e in runs.forward(payload, parent, seen)]

    closing = runs.close_all(suspended=True)

    assert [e.type for e in closing] == [
        EventType.TEXT_MESSAGE_END,
        EventType.SUBAGENT_FINISHED,
        EventType.SUBAGENT_FINISHED,
    ]
    assert [e.subagent_run_id for e in closing if e.type == EventType.SUBAGENT_FINISHED] == [
        "a::b",
        "a",
    ]
    assert {e.outcome.type for e in closing if e.type == EventType.SUBAGENT_FINISHED} == {
        "suspended"
    }
    assert runs.close_all(suspended=False) == []


@pytest.mark.asyncio
async def test_a_non_agent_generator_tool_is_not_announced():
    runs = SubagentRuns("attributed", _no_tool_calls)
    events = [
        e async for e in runs.forward({"progress": 0.5}, {"toolUseId": "x", "name": "x"}, {})
    ]
    assert events == []
    assert runs.close_all(suspended=False) == []


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_generator_tool_with_agent_like_keys_is_not_a_subagent():
    @tool
    async def downloader(url: str):
        """Download a file, reporting progress."""
        yield {"data": "50%"}
        yield {"message": "almost done"}
        yield "done"

    parent = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p1", "downloader", '{"url": "x"}'), _text_turn("ok")]
        ),
        tools=[downloader],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "attributed"))

    assert not [e for e in events if e.type in SUBAGENT_LIFECYCLE]
    assert not [e for e in events if getattr(e, "subagent_run_id", None)]


@pytest.mark.asyncio
async def test_a_binary_spawning_result_still_encodes():
    inner = StrandsAgentCore(
        model=ScriptedModel([_text_turn("Drawn.")]), callback_handler=None
    )

    @tool
    async def painter(prompt: str):
        """Delegate drawing to a sub-agent."""
        async for event in inner.stream_async(prompt):
            yield event
        yield {
            "status": "success",
            "content": [{"image": {"format": "png", "source": {"bytes": b"\x89PNG"}}}],
        }

    parent = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p_img", "painter", '{"prompt": "cat"}'), _text_turn("ok")]
        ),
        tools=[painter],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "attributed"))

    (finished,) = _of(events, EventType.SUBAGENT_FINISHED)
    assert finished.subagent_run_id == "p_img"
    assert events[-1].type == EventType.RUN_FINISHED


@tool(context=True)
def confirm_action(key: str, tool_context: ToolContext) -> dict:
    """Ask a human to confirm."""
    tool_context.interrupt("confirm_action", reason={"key": key})
    return {"status": "success", "content": [{"text": f"confirmed {key}"}]}


@pytest.mark.asyncio
async def test_a_finished_subagent_is_not_suspended_by_an_interrupting_sibling():
    agent = _helper_beside_interrupting_sibling()
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    assert events[-1].type == EventType.RUN_FINISHED
    assert events[-1].outcome.type == "interrupt"
    (finished,) = _of(events, EventType.SUBAGENT_FINISHED)
    assert finished.subagent_run_id == "p_sub"
    assert finished.outcome.type == "success"


@pytest.mark.asyncio
async def test_payloads_after_the_spawning_result_are_dropped():
    runs = SubagentRuns("attributed", _no_tool_calls)
    parent = {"toolUseId": "x", "name": "x"}
    _ = [e async for e in runs.forward({"init_event_loop": True}, parent, {})]
    runs.finish("x", "success", '"ok"')

    late = [e async for e in runs.forward({"data": "late"}, parent, {})]

    assert late == []
    assert runs.close_all(suspended=False) == []


@pytest.mark.asyncio
async def test_skip_messages_snapshot_also_skips_the_subagents_messages():
    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(
            subagent_visibility="attributed",
            tool_behaviors={"research_agent": ToolBehavior(skip_messages_snapshot=True)},
        ),
    )
    agent._agents_by_thread["t1"] = _nested_agent()
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    assert _of(events, EventType.SUBAGENT_FINISHED)
    for snapshot in _of(events, EventType.MESSAGES_SNAPSHOT):
        assert not [m for m in snapshot.messages if m.subagent_run_id]


@pytest.mark.asyncio
async def test_attributed_without_snapshots_still_streams_the_subagent():
    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(
            subagent_visibility="attributed", emit_messages_snapshot=False
        ),
    )
    agent._agents_by_thread["t1"] = _nested_agent()
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    assert not _of(events, EventType.MESSAGES_SNAPSHOT)
    assert len(_of(events, EventType.SUBAGENT_STARTED)) == 1
    assert len(_of(events, EventType.SUBAGENT_FINISHED)) == 1


@pytest.mark.asyncio
async def test_attributed_tags_the_subagents_reasoning():
    reasoning_turn = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"reasoningContent": {"text": "Thinking."}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {}}},
        {"contentBlockDelta": {"delta": {"text": "Answer."}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "end_turn"}},
    ]
    inner = StrandsAgentCore(model=ScriptedModel([reasoning_turn]), callback_handler=None)

    @tool
    async def thinker(q: str):
        """Delegate to a reasoning sub-agent."""
        async for event in inner.stream_async(q):
            yield event

    parent = StrandsAgentCore(
        model=ScriptedModel([_tool_turn("p_r", "thinker", '{"q": "x"}'), _text_turn("ok")]),
        tools=[thinker],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "attributed"))

    reasoning = _of(events, EventType.REASONING_MESSAGE_CONTENT)
    assert "".join(e.delta for e in reasoning) == "Thinking."
    assert {e.subagent_run_id for e in reasoning} == {"p_r"}
    assert {e.subagent_run_id for e in _of(events, EventType.REASONING_END)} == {"p_r"}


def test_strip_drops_namespaced_ids_and_emptied_messages():
    history = [
        UserMessage(id="u1", role="user", content="q"),
        AssistantMessage(
            id="a1",
            role="assistant",
            tool_calls=[
                ToolCall(id="p1", type="function", function=FunctionCall(name="r", arguments="{}"))
            ],
        ),
        # Untagged sub-agent text, recognised by the namespaced id.
        AssistantMessage(id="p1::m1", role="assistant", content="inner"),
        # Only flattened inner calls: nothing is left once they go.
        AssistantMessage(
            id="a_only_inner",
            role="assistant",
            tool_calls=[
                ToolCall(id="p1::i1", type="function", function=FunctionCall(name="l", arguments="{}"))
            ],
        ),
        ToolMessage(id="t1", role="tool", content="done", tool_call_id="p1"),
    ]

    assert [m.id for m in strip_subagent_messages(history)] == ["u1", "a1", "t1"]


def test_unknown_visibility_is_refused_by_the_config():
    with pytest.raises(ValueError, match="subagent_visibility"):
        StrandsAgentConfig(subagent_visibility="flattened")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Snapshot ownership: each invocation answers to its own spawning tool
# ---------------------------------------------------------------------------


def _attributed_ids(events: list) -> list[str]:
    last = _of(events, EventType.MESSAGES_SNAPSHOT)[-1]
    return [m.subagent_run_id for m in last.messages if m.subagent_run_id]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "skipped, kept",
    [("weather_agent", "parent_b"), ("finance_agent", "parent_a")],
)
async def test_parallel_subagents_each_follow_their_own_snapshot_policy(skipped, kept):
    sequencer = _Sequencer(["A:tooluse#1", "B:stop#1", "A:tooluse#2", "A:stop#1"])
    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(
            subagent_visibility="attributed",
            tool_behaviors={skipped: ToolBehavior(skip_messages_snapshot=True)},
        ),
    )
    agent._agents_by_thread["t1"] = _parallel_agent_as_tool_parent(sequencer)
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    ids = _attributed_ids(events)
    assert ids
    assert set(ids) == {kept}


@pytest.mark.asyncio
async def test_an_invocations_messages_include_its_descendants_only():
    runs = SubagentRuns("attributed", _no_tool_calls)

    def nested(data: dict) -> dict:
        return {"tool_stream_event": {"tool_use": {"toolUseId": "n", "name": "n"}, "data": data}}

    for call_id, payload in (
        ("a", {"init_event_loop": True}),
        ("a", nested({"init_event_loop": True})),
        ("a", nested({"data": "deep"})),
        ("b", {"init_event_loop": True}),
        ("b", {"data": "other"}),
    ):
        tool_use = {"toolUseId": call_id, "name": call_id}
        _ = [e async for e in runs.forward(payload, tool_use, {})]
    _ = runs.close_all(suspended=False)

    assert [m.subagent_run_id for m in runs.take_snapshot_messages("a")] == ["a::n"]
    assert runs.take_snapshot_messages("a") == []
    ((tool_name, messages),) = runs.take_remaining_snapshot_messages()
    assert tool_name == "b"
    assert [m.subagent_run_id for m in messages] == ["b"]


@pytest.mark.asyncio
async def test_parallel_subagents_messages_precede_their_own_result():
    sequencer = _Sequencer(["A:tooluse#1", "B:stop#1", "A:tooluse#2", "A:stop#1"])
    events = await _collect(
        _wrap(_parallel_agent_as_tool_parent(sequencer), "attributed")
    )

    messages = _of(events, EventType.MESSAGES_SNAPSHOT)[-1].messages
    for run_id in ("parent_a", "parent_b"):
        result = _index(
            messages,
            lambda m: m.role == "tool" and m.tool_call_id == run_id,
        )
        owned = [i for i, m in enumerate(messages) if m.subagent_run_id == run_id]
        assert owned
        assert max(owned) < result


# ---------------------------------------------------------------------------
# Interrupts: a closed run's messages still reach the last snapshot
# ---------------------------------------------------------------------------


def _helper_beside_interrupting_sibling(
    tool_behaviors: dict | None = None,
) -> StrandsAgent:
    inner = StrandsAgentCore(
        model=ScriptedModel([_text_turn("inner answer")]), callback_handler=None
    )

    @tool
    async def helper(q: str):
        """Delegate to a sub-agent."""
        async for event in inner.stream_async(q):
            yield event

    batch = [
        {"messageStart": {"role": "assistant"}},
        {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "p_sub", "name": "helper"}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"q": "x"}'}}}},
        {"contentBlockStop": {}},
        {"contentBlockStart": {"start": {"toolUse": {"toolUseId": "p_conf", "name": "confirm_action"}}}},
        {"contentBlockDelta": {"delta": {"toolUse": {"input": '{"key": "k"}'}}}},
        {"contentBlockStop": {}},
        {"messageStop": {"stopReason": "tool_use"}},
    ]
    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(
            subagent_visibility="attributed",
            tool_behaviors={
                "confirm_action": ToolBehavior(interrupt_on_call=True),
                **(tool_behaviors or {}),
            },
        ),
    )
    agent._agents_by_thread["t1"] = StrandsAgentCore(
        model=ScriptedModel([batch, _text_turn("ok")]),
        tools=[helper, confirm_action],
        callback_handler=None,
    )
    return agent


@pytest.mark.asyncio
async def test_an_interrupted_run_publishes_a_finished_subagents_messages():
    agent = _helper_beside_interrupting_sibling()
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    assert events[-1].type == EventType.RUN_FINISHED
    assert events[-1].outcome.type == "interrupt"
    finished = _index(events, lambda e: e.type == EventType.SUBAGENT_FINISHED)
    last = max(
        i for i, e in enumerate(events) if e.type == EventType.MESSAGES_SNAPSHOT
    )
    assert finished < last

    messages = events[last].messages
    (owned,) = [m for m in messages if m.subagent_run_id == "p_sub"]
    assert owned.content == "inner answer"
    spawning = _index(
        messages,
        lambda m: m.role == "assistant"
        and any(tc.id == "p_sub" for tc in (m.tool_calls or [])),
    )
    assert spawning < messages.index(owned)


@pytest.mark.asyncio
async def test_an_interrupted_run_respects_skip_messages_snapshot():
    agent = _helper_beside_interrupting_sibling(
        {"helper": ToolBehavior(skip_messages_snapshot=True)}
    )
    events = [event async for event in agent.run(_input())]
    _assert_stream_encodes(events)

    assert _of(events, EventType.SUBAGENT_FINISHED)
    for snapshot in _of(events, EventType.MESSAGES_SNAPSHOT):
        assert not [m for m in snapshot.messages if m.subagent_run_id]


# ---------------------------------------------------------------------------
# Hidden: the boundary covers everything a sub-agent's wrapper yields
# ---------------------------------------------------------------------------


def _wrapper_yielding_after_its_agent(payload: dict) -> StrandsAgentCore:
    inner = StrandsAgentCore(
        model=ScriptedModel([_text_turn("inner answer")]), callback_handler=None
    )

    @tool
    async def wrapper(q: str):
        """Delegate to a sub-agent, then report on it."""
        async for event in inner.stream_async(q):
            yield event
        yield payload

    return StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p_wrap", "wrapper", '{"q": "x"}'), _text_turn("Done.")]
        ),
        tools=[wrapper],
        callback_handler=None,
    )


def _state_snapshots_with(events: list, key: str) -> list:
    return [
        e
        for e in _of(events, EventType.STATE_SNAPSHOT)
        if isinstance(e.snapshot, dict) and key in e.snapshot
    ]


@pytest.mark.asyncio
async def test_hidden_keeps_a_wrappers_state_from_the_client():
    parent = _wrapper_yielding_after_its_agent(
        {"state": {"internal_marker": "private-progress"}}
    )
    events = await _collect(_wrap(parent, "hidden"))

    assert not _state_snapshots_with(events, "internal_marker")
    assert [e.tool_call_id for e in _of(events, EventType.TOOL_CALL_RESULT)] == ["p_wrap"]


@pytest.mark.asyncio
async def test_hidden_keeps_a_wrappers_a2ui_progress_from_the_client():
    parent = _wrapper_yielding_after_its_agent(
        {
            A2UI_STREAM_KEY: {
                "kind": "start",
                "tool_call_id": "a2ui_1",
                "tool_call_name": "render_a2ui",
            }
        }
    )
    events = await _collect(_wrap(parent, "hidden"))

    assert [e.tool_call_name for e in _of(events, EventType.TOOL_CALL_START)] == ["wrapper"]


@pytest.mark.asyncio
@pytest.mark.parametrize("visibility", ["inline", "attributed"])
async def test_only_hidden_withholds_a_wrappers_state(visibility):
    parent = _wrapper_yielding_after_its_agent({"state": {"marker": 1}})
    events = await _collect(_wrap(parent, visibility))

    assert _state_snapshots_with(events, "marker")


@pytest.mark.asyncio
async def test_hidden_keeps_ordinary_tool_state_updates():
    @tool
    async def progress(q: str):
        """An ordinary generator tool that reports state."""
        yield {"state": {"progress": 50}}
        yield "done"

    parent = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p_prog", "progress", '{"q": "x"}'), _text_turn("Done.")]
        ),
        tools=[progress],
        callback_handler=None,
    )
    events = await _collect(_wrap(parent, "hidden"))

    assert _state_snapshots_with(events, "progress")


@pytest.mark.asyncio
async def test_hidden_leaves_an_explicit_stream_handler_its_payloads():
    seen: list = []

    async def handler(context):
        seen.append(context.stream_data)
        return
        yield  # pragma: no cover

    agent = StrandsAgent(
        _template_agent(),
        name="test-agent",
        config=StrandsAgentConfig(
            subagent_visibility="hidden",
            tool_behaviors={
                "wrapper": ToolBehavior(tool_stream_event_handler=handler)
            },
        ),
    )
    agent._agents_by_thread["t1"] = _wrapper_yielding_after_its_agent(
        {"state": {"marker": 1}}
    )
    _ = [event async for event in agent.run(_input())]

    assert {"state": {"marker": 1}} in seen


# ---------------------------------------------------------------------------
# Abandoned: an unfinished child is never reported as a success
# ---------------------------------------------------------------------------


def _failing_wrapper_around_a_nested_child(fails_on) -> StrandsAgentCore:
    """outer wraps mid, mid delegates to leaf; outer raises mid-stream."""
    leaf = StrandsAgentCore(
        model=ScriptedModel([_text_turn("leaf answer")]), callback_handler=None
    )

    @tool
    async def leaf_agent(q: str):
        """Delegate to the leaf."""
        async for event in leaf.stream_async(q):
            yield event

    mid = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("mid_1", "leaf_agent", '{"q": "x"}'), _text_turn("mid answer")]
        ),
        tools=[leaf_agent],
        callback_handler=None,
    )

    @tool
    async def outer_agent(q: str):
        """Delegate to mid, then fail."""
        async for event in mid.stream_async(q):
            yield event
            nested = event.get("tool_stream_event") if isinstance(event, dict) else None
            if nested and fails_on(nested.get("data")):
                raise RuntimeError("wrapper failed")

    return StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p_outer", "outer_agent", '{"q": "x"}'), _text_turn("Done.")]
        ),
        tools=[outer_agent],
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_a_failing_wrapper_reports_its_streaming_child_as_abandoned():
    parent = _failing_wrapper_around_a_nested_child(
        lambda data: isinstance(data, dict) and data.get("data") == "leaf answer"
    )
    events = await _collect(_wrap(parent, "attributed"))

    assert not _of(events, EventType.SUBAGENT_FINISHED)
    child, outer = _of(events, EventType.SUBAGENT_ERROR)
    assert child.subagent_run_id == "p_outer::mid_1"
    assert child.code == SUBAGENT_ABANDONED_CODE
    assert outer.subagent_run_id == "p_outer"
    assert outer.code == SUBAGENT_ERROR_CODE
    assert events.index(child) < events.index(outer)
    # Its stream is closed, and what it produced stays attributed to it.
    text_end = _index(
        events,
        lambda e: e.type == EventType.TEXT_MESSAGE_END
        and e.subagent_run_id == "p_outer::mid_1",
    )
    assert text_end < events.index(child)
    assert "p_outer::mid_1" in _attributed_ids(events)


@pytest.mark.asyncio
async def test_a_failing_wrapper_keeps_a_completed_childs_success():
    parent = _failing_wrapper_around_a_nested_child(
        lambda data: isinstance(data, dict) and "result" in data
    )
    events = await _collect(_wrap(parent, "attributed"))

    (child,) = _of(events, EventType.SUBAGENT_FINISHED)
    assert child.subagent_run_id == "p_outer::mid_1"
    assert child.outcome.type == "success"
    (outer,) = _of(events, EventType.SUBAGENT_ERROR)
    assert outer.subagent_run_id == "p_outer"
    assert events.index(child) < events.index(outer)


@pytest.mark.asyncio
async def test_close_all_reports_an_unanswered_unfinished_run_as_abandoned():
    runs = SubagentRuns("attributed", _no_tool_calls)
    for call_id, payload in (
        ("unfinished", {"init_event_loop": True}),
        ("completed", {"init_event_loop": True}),
        ("completed", {"result": "done"}),
    ):
        tool_use = {"toolUseId": call_id, "name": call_id}
        _ = [e async for e in runs.forward(payload, tool_use, {})]

    closing = {e.subagent_run_id: e for e in runs.close_all(suspended=False)}

    assert closing["unfinished"].type == EventType.SUBAGENT_ERROR
    assert closing["unfinished"].code == SUBAGENT_ABANDONED_CODE
    assert closing["completed"].type == EventType.SUBAGENT_FINISHED
    assert closing["completed"].outcome.type == "success"


# ---------------------------------------------------------------------------
# Closing at depth: completed descendants, and tool calls left open
# ---------------------------------------------------------------------------


def _failing_wrapper_two_levels_above_a_leaf() -> StrandsAgentCore:
    """outer wraps upper, upper delegates to mid, mid delegates to leaf.

    outer raises right after the leaf's final result, before mid has it.
    """
    leaf = StrandsAgentCore(
        model=ScriptedModel([_text_turn("leaf answer")]), callback_handler=None
    )

    @tool
    async def leaf_agent(q: str):
        """Delegate to the leaf."""
        async for event in leaf.stream_async(q):
            yield event

    mid = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("m1", "leaf_agent", '{"q": "x"}'), _text_turn("mid answer")]
        ),
        tools=[leaf_agent],
        callback_handler=None,
    )

    @tool
    async def mid_agent(q: str):
        """Delegate to mid."""
        async for event in mid.stream_async(q):
            yield event

    upper = StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("u1", "mid_agent", '{"q": "x"}'), _text_turn("upper answer")]
        ),
        tools=[mid_agent],
        callback_handler=None,
    )

    @tool
    async def outer_agent(q: str):
        """Delegate to upper, then fail."""
        async for event in upper.stream_async(q):
            yield event
            mid_stream = event.get("tool_stream_event") if isinstance(event, dict) else None
            mid_event = (mid_stream or {}).get("data")
            leaf_stream = (
                mid_event.get("tool_stream_event") if isinstance(mid_event, dict) else None
            )
            leaf_event = (leaf_stream or {}).get("data")
            if isinstance(leaf_event, dict) and "result" in leaf_event:
                raise RuntimeError("wrapper failed")

    return StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("p_outer", "outer_agent", '{"q": "x"}'), _text_turn("Done.")]
        ),
        tools=[outer_agent],
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_an_abandoned_run_keeps_a_completed_descendants_success():
    events = await _collect(
        _wrap(_failing_wrapper_two_levels_above_a_leaf(), "attributed")
    )

    (leaf,) = _of(events, EventType.SUBAGENT_FINISHED)
    assert leaf.subagent_run_id == "p_outer::u1::m1"
    assert leaf.outcome.type == "success"
    mid, outer = _of(events, EventType.SUBAGENT_ERROR)
    assert mid.subagent_run_id == "p_outer::u1"
    assert mid.code == SUBAGENT_ABANDONED_CODE
    assert outer.subagent_run_id == "p_outer"
    assert outer.code == SUBAGENT_ERROR_CODE
    assert events.index(leaf) < events.index(mid) < events.index(outer)


@pytest.mark.asyncio
async def test_abandoning_a_run_applies_the_completion_check_at_every_depth():
    runs = SubagentRuns("attributed", _no_tool_calls)
    for call_id, parent, payload in (
        ("outer", None, {"init_event_loop": True}),
        ("outer::mid", "outer", {"init_event_loop": True}),
        ("outer::mid::done", "outer::mid", {"init_event_loop": True}),
        ("outer::mid::done", "outer::mid", {"result": "done"}),
        ("outer::mid::open", "outer::mid", {"init_event_loop": True}),
    ):
        tool_use = {"toolUseId": call_id, "name": call_id}
        _ = [e async for e in runs.forward(payload, tool_use, {}, parent_run_id=parent)]

    closing = {e.subagent_run_id: e for e in runs.finish("outer", "error", "boom")}

    assert closing["outer::mid::done"].type == EventType.SUBAGENT_FINISHED
    assert closing["outer::mid::done"].outcome.type == "success"
    assert closing["outer::mid::open"].code == SUBAGENT_ABANDONED_CODE
    assert closing["outer::mid"].code == SUBAGENT_ABANDONED_CODE
    assert closing["outer"].code == SUBAGENT_ERROR_CODE


def _assert_tool_calls_closed_once(events: list) -> None:
    """The client verifier's rule: nothing open at RUN_FINISHED, one END per call."""
    open_calls: set[str] = set()
    for event in events:
        if event.type == EventType.TOOL_CALL_START:
            assert event.tool_call_id not in open_calls
            open_calls.add(event.tool_call_id)
        elif event.type == EventType.TOOL_CALL_END:
            assert event.tool_call_id in open_calls
            open_calls.remove(event.tool_call_id)
        elif event.type == EventType.RUN_FINISHED:
            assert not open_calls


def _wrapper_failing_on_the_inner_tool_use() -> StrandsAgentCore:
    """A wrapper that raises just after re-yielding the inner call's first payload."""

    @tool
    def lookup_weather(city: str) -> str:
        """Look up the weather for a city."""
        return f"sunny in {city}"

    inner = StrandsAgentCore(
        model=ScriptedModel([_tool_turn("inner_call", "lookup_weather", '{"city": "P"}')]),
        tools=[lookup_weather],
        callback_handler=None,
    )

    @tool
    async def researcher(q: str):
        """Delegate, then fail."""
        async for event in inner.stream_async(q):
            yield event
            if isinstance(event, dict) and "current_tool_use" in event:
                raise RuntimeError("wrapper failed")

    return StrandsAgentCore(
        model=ScriptedModel(
            [_tool_turn("root", "researcher", '{"q": "x"}'), _text_turn("Recovered.")]
        ),
        tools=[researcher],
        callback_handler=None,
    )


@pytest.mark.asyncio
async def test_a_failing_invocation_closes_its_open_inner_tool_call():
    events = await _collect(
        _wrap(_wrapper_failing_on_the_inner_tool_use(), "attributed")
    )

    _assert_tool_calls_closed_once(events)
    (end,) = [
        e
        for e in _of(events, EventType.TOOL_CALL_END)
        if e.tool_call_id == "root::inner_call"
    ]
    assert end.subagent_run_id == "root"
    (error,) = _of(events, EventType.SUBAGENT_ERROR)
    assert events.index(end) < events.index(error)
    assert _of(events, EventType.RUN_FINISHED)


@pytest.mark.asyncio
async def test_a_cut_off_inner_call_is_marked_aborted_on_its_end():
    events = await _collect(
        _wrap(_wrapper_failing_on_the_inner_tool_use(), "attributed")
    )

    (end,) = [
        e
        for e in _of(events, EventType.TOOL_CALL_END)
        if e.tool_call_id == "root::inner_call"
    ]
    assert end.metadata == {AGUI_METADATA_KEY: {"aborted": True}}
    # Only the cut-off call carries the marker; the spawning call ended normally.
    marked = [
        e.tool_call_id
        for e in _of(events, EventType.TOOL_CALL_END)
        if e.metadata and e.metadata.get(AGUI_METADATA_KEY, {}).get("aborted")
    ]
    assert marked == ["root::inner_call"]


@pytest.mark.asyncio
async def test_the_snapshot_keeps_the_aborted_marker_and_the_raw_arguments():
    events = await _collect(
        _wrap(_wrapper_failing_on_the_inner_tool_use(), "attributed")
    )

    messages = _of(events, EventType.MESSAGES_SNAPSHOT)[-1].messages
    calls = {
        tc.id: tc
        for m in messages
        if getattr(m, "role", None) == "assistant"
        for tc in (m.tool_calls or [])
    }
    inner = calls["root::inner_call"]
    assert inner.metadata == {AGUI_METADATA_KEY: {"aborted": True}}
    # The arguments are exactly what was streamed, not repaired or replaced.
    streamed = "".join(
        e.delta
        for e in _of(events, EventType.TOOL_CALL_ARGS)
        if e.tool_call_id == "root::inner_call"
    )
    assert streamed
    assert inner.function.arguments == streamed
    # No other call is marked.
    assert all(tc.metadata is None for cid, tc in calls.items() if cid != inner.id)


def _inner_tool_use(call_id: str) -> dict:
    return {"current_tool_use": {"toolUseId": call_id, "name": "search", "input": '{"q'}}


@pytest.mark.asyncio
async def test_closing_ends_open_tool_calls_once_under_their_own_run():
    runs = SubagentRuns("attributed", _forward_inner_agent_events)
    seen: dict = {}
    for call_id, parent, payload in (
        ("a", None, _inner_tool_use("x")),
        ("a::child", "a", _inner_tool_use("y")),
        ("b", None, _inner_tool_use("x")),
    ):
        tool_use = {"toolUseId": call_id, "name": call_id}
        _ = [e async for e in runs.forward(payload, tool_use, seen, parent_run_id=parent)]

    closing = runs.finish("a", "error", "boom")

    # Deepest first, each under its own run, and the sibling's call stays open.
    ends = [
        (e.tool_call_id, e.subagent_run_id)
        for e in closing
        if e.type == EventType.TOOL_CALL_END
    ]
    assert ends == [("a::child::y", "a::child"), ("a::x", "a")]
    assert seen["b::x"]["ended"] is False

    # A late stop from the closed run's stream does not end anything twice.
    late = {"event": {"contentBlockStop": {}}}
    assert not [e async for e in runs.forward(late, {"toolUseId": "a"}, seen)]


@pytest.mark.asyncio
@pytest.mark.parametrize("suspended", [True, False])
async def test_close_all_ends_a_runs_open_tool_call(suspended):
    runs = SubagentRuns("attributed", _forward_inner_agent_events)
    tool_use = {"toolUseId": "a", "name": "a"}
    _ = [e async for e in runs.forward(_inner_tool_use("x"), tool_use, {})]

    closing = runs.close_all(suspended=suspended)

    assert closing[0].type == EventType.TOOL_CALL_END
    assert closing[0].tool_call_id == "a::x"
    assert closing[0].subagent_run_id == "a"
    assert closing[-1].subagent_run_id == "a"


@pytest.mark.asyncio
async def test_a_completed_subagents_tool_calls_end_only_once():
    events = await _collect(_wrap(_as_tool_agent(), "attributed"))
    _assert_tool_calls_closed_once(events)
