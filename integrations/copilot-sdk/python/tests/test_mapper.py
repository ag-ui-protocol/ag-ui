import json

import pytest
from ag_ui.core import BaseEvent

from ag_ui_copilot_sdk import EventMapper


def sdk(kind, **data):
    return {"type": kind, "data": data}


def dump(events):
    assert all(isinstance(event, BaseEvent) for event in events)
    return [event.model_dump(mode="json", by_alias=True, exclude_none=True) for event in events]


def types(events):
    return [event.type.value for event in events]


def test_streaming_final_dedup_and_closure():
    mapper = EventMapper()
    delta = sdk("assistant.message_delta", messageId="m", deltaContent="Hello")
    delta["id"] = "e"
    assert types(mapper.map_event(delta)) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT"]
    assert mapper.map_event(delta) == []
    end = mapper.map_event(sdk("assistant.message", messageId="m", content="Hello world"))
    assert end[0].delta == " world"
    assert types(end) == ["TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]
    assert mapper.map_event(sdk("assistant.message", messageId="m", content="Hello world")) == []
    assert mapper.finish() == []


def test_full_message_fallback_and_empty():
    mapper = EventMapper()
    assert types(mapper.map_event(sdk("assistant.message", messageId="m", content="text"))) == [
        "TEXT_MESSAGE_START",
        "TEXT_MESSAGE_CONTENT",
        "TEXT_MESSAGE_END",
    ]
    assert mapper.map_event(sdk("assistant.message", messageId="empty", content="")) == []


def test_reasoning_opaque_omitted_and_orphan_closed():
    mapper = EventMapper()
    events = mapper.map_event(
        sdk("assistant.reasoning_delta", reasoningId="r", deltaContent="Readable")
    )
    assert types(events) == [
        "REASONING_START",
        "REASONING_MESSAGE_START",
        "REASONING_MESSAGE_CONTENT",
    ]
    assert types(mapper.finish()) == ["REASONING_MESSAGE_END", "REASONING_END"]
    assert mapper.map_event(sdk("assistant.reasoning", reasoningId="r", content="Readable")) == []
    assert mapper.map_event(sdk("assistant.reasoning_opaque", content="secret")) == []
    events = mapper.map_event(
        sdk("assistant.message", messageId="m", content="", reasoningOpaque="secret")
    )
    assert "secret" not in json.dumps(dump(events))


def test_tool_argument_deltas_never_stdout_and_full_authoritative():
    mapper = EventMapper()
    assert (
        mapper.map_event(
            sdk("assistant.tool_call_delta", toolCallId="t", toolName="loo", inputDelta='{"lab')
        )
        == []
    )
    mapper.map_event(
        sdk(
            "assistant.tool_call_delta", toolCallId="t", toolName="lookup", inputDelta='el":"demo"}'
        )
    )
    events = mapper.map_event(
        sdk("tool.execution_start", toolCallId="t", toolName="lookup", arguments={"label": "demo"})
    )
    assert types(events) == [
        "TOOL_CALL_START",
        "TOOL_CALL_ARGS",
        "TOOL_CALL_END",
        "ACTIVITY_SNAPSHOT",
    ]
    assert json.loads(events[1].delta) == {"label": "demo"}
    assert events[-1].content["output"] == ""
    assert mapper.map_event(sdk("external_tool.requested", toolCallId="t", toolName="lookup")) == []
    assert mapper.finish() == []


def test_argument_buffer_used_only_after_real_name_and_malformed_rejected():
    mapper = EventMapper()
    mapper.map_event(sdk("assistant.tool_call_delta", toolCallId="t", inputDelta='{"x":1}'))
    events = mapper.map_event(sdk("tool.execution_start", toolCallId="t", toolName="full_name"))
    assert events[0].tool_call_name == "full_name"
    assert events[1].delta == '{"x":1}'
    mapper.map_event(sdk("assistant.tool_call_delta", toolCallId="bad", inputDelta='{"x"'))
    with pytest.raises(ValueError):
        mapper.map_event(sdk("tool.execution_start", toolCallId="bad", toolName="bad"))


@pytest.mark.parametrize(
    "success,code,status",
    [(True, None, "completed"), (False, "oops", "error"), (False, "cancelled", "cancelled")],
)
def test_partial_output_progress_failure_exit_and_result_dedup(success, code, status):
    mapper = EventMapper()
    mapper.map_event(
        sdk(
            "tool.execution_start",
            toolCallId="t",
            toolName="bash",
            arguments={},
            shellToolInfo={"displayCommand": "printf safe"},
        )
    )
    partial = mapper.map_event(
        sdk("tool.execution_partial_result", toolCallId="t", partialOutput="real stdout\n")
    )
    assert partial[0].content["output"] == "real stdout\n"
    progress = mapper.map_event(
        sdk("tool.execution_progress", toolCallId="t", progressMessage="still running")
    )
    assert progress[0].content["progress"] == "still running"
    event = sdk(
        "tool.execution_complete",
        toolCallId="t",
        success=success,
        result={"content": ""},
        error={"message": "failed", "code": code or ""},
        shellExecution={"exitCode": 0 if success else 1},
    )
    result = mapper.map_event(event)
    assert result[0].content == ""
    assert result[1].content["status"] == status
    assert result[1].content["output"] == "real stdout\n"
    assert result[1].content["exitCode"] == (0 if success else 1)
    assert mapper.map_event(event) == []


def test_output_truncation_and_limits():
    mapper = EventMapper(max_output_chars=8)
    mapper.map_event(sdk("tool.execution_start", toolCallId="t", toolName="tool", arguments={}))
    event = mapper.map_event(
        sdk("tool.execution_partial_result", toolCallId="t", partialOutput="a" * 20)
    )[0]
    assert event.content["output"] == "a" * 8 and event.content["truncated"]
    with pytest.raises(ValueError, match="output limit"):
        mapper.map_event(sdk("assistant.message_delta", messageId="m", deltaContent="a" * 20))
    with pytest.raises(ValueError, match="arguments limit"):
        mapper.map_event(sdk("assistant.tool_call_delta", toolCallId="x", inputDelta="a" * 20))
    mapper = EventMapper(max_events=1)
    mapper.map_event({"id": "one", **sdk("ignored")})
    with pytest.raises(ValueError, match="limit"):
        mapper.map_event({"id": "two", **sdk("ignored")})


def test_child_identity_and_real_relationship_never_log_parent():
    mapper = EventMapper()
    for child in ("child-one", "child-two"):
        mapper.map_event(
            {
                "agentId": child,
                **sdk("subagent.started", toolCallId=child, agentName="research"),
            }
        )
    first = mapper.map_event(
        {
            "agentId": "child-one",
            "parentId": "log-event",
            **sdk("assistant.message_delta", messageId="shared", deltaContent="A"),
        }
    )
    second = mapper.map_event(
        {
            "agentId": "child-two",
            **sdk("assistant.message_delta", messageId="shared", deltaContent="B"),
        }
    )
    assert first[0].message_id != second[0].message_id
    start = mapper.map_event(
        {
            "parentId": "log-event",
            **sdk(
                "subagent.started",
                toolCallId="child-one",
                agentName="research",
                agentDescription="Inspect",
            ),
        }
    )[-1]
    assert "parentToolCallId" not in start.content
    assert start.activity_type == "copilot-sdk:subagent"
    nested = mapper.map_event(
        sdk(
            "tool.execution_start",
            toolCallId="nested",
            toolName="lookup",
            parentToolCallId="child-one",
        )
    )[-1]
    assert nested.content["parentToolCallId"] == "child-one"
    assert "log-event" not in json.dumps(dump(first + second + [start, nested]))
    assert "ACTIVITY_SNAPSHOT" in types(mapper.finish(cancelled=True))


def test_unsupported_events_and_orphan_results_are_not_raw():
    mapper = EventMapper()
    assert mapper.map_event(sdk("session.start", token="secret")) == []
    assert mapper.map_event(sdk("tool.execution_complete", toolCallId="orphan", success=True)) == []
    with pytest.raises(TypeError):
        mapper.map_event({"data": {}})


def test_execution_metadata_arrives_after_assistant_tool_request():
    mapper = EventMapper()
    mapper.map_event(
        sdk(
            "assistant.message",
            messageId="m",
            content="",
            toolRequests=[
                {"toolCallId": "t", "name": "bash", "arguments": {"command": "not stdout"}},
            ],
        )
    )
    events = mapper.map_event(
        sdk(
            "tool.execution_start",
            toolCallId="t",
            toolName="bash",
            shellToolInfo={"displayCommand": "printf safe"},
        )
    )
    assert events[0].content["command"] == "printf safe"
    assert events[0].content["output"] == ""
    assert types(events) == ["ACTIVITY_SNAPSHOT"]


def test_parent_turn_end_does_not_close_concurrent_child_stream():
    mapper = EventMapper()
    mapper.map_event(
        {
            "agentId": "child",
            **sdk("subagent.started", toolCallId="child", agentName="worker"),
        }
    )
    mapper.map_event(sdk("assistant.message_delta", messageId="p", deltaContent="parent"))
    mapper.map_event(
        {"agentId": "child", **sdk("assistant.message_delta", messageId="c", deltaContent="child")}
    )
    assert [e.message_id for e in mapper.map_event(sdk("assistant.turn_end"))] == ["p"]
    assert (
        mapper.map_event(
            {
                "agentId": "child",
                **sdk("assistant.message_delta", messageId="c", deltaContent=" more"),
            }
        )[0].delta
        == " more"
    )
    assert [e.message_id for e in mapper.finish()] == ["child:c"]


def test_native_nonzero_exit_is_error_even_when_tool_success_is_true():
    mapper = EventMapper()
    mapper.map_event(sdk("tool.execution_start", toolCallId="shell", toolName="bash"))
    events = mapper.map_event(
        sdk(
            "tool.execution_complete",
            toolCallId="shell",
            success=True,
            result={"content": "Process exited 7"},
            shellExecution={"exitCode": 7},
        )
    )
    assert events[-1].content["status"] == "error"
    assert events[-1].content["exitCode"] == 7


def test_native_abort_cancels_running_activity_without_tool_completion():
    mapper = EventMapper()
    mapper.map_event(sdk("tool.execution_start", toolCallId="shell", toolName="bash"))
    events = mapper.map_event(sdk("abort"))
    assert events[-1].content["status"] == "cancelled"
    assert "TOOL_CALL_RESULT" not in types(events)


def test_native_agent_identity_maps_to_spawn_tool_without_self_parent():
    mapper = EventMapper()
    mapper.map_event(sdk("tool.execution_start", toolCallId="spawn", toolName="task"))
    started = mapper.map_event(
        {
            "agentId": "agent-session-id",
            "parentId": "chronological-log-id",
            **sdk(
                "subagent.started", toolCallId="spawn", agentName="child", agentDescription="safe"
            ),
        }
    )[-1]
    assert "parentToolCallId" not in started.content
    message = mapper.map_event(
        {
            "agentId": "agent-session-id",
            **sdk("assistant.message_delta", messageId="m", deltaContent="child"),
        }
    )[0]
    assert message.message_id == "spawn:m"
    nested = mapper.map_event(
        {
            "agentId": "agent-session-id",
            **sdk("tool.execution_start", toolCallId="nested", toolName="lookup"),
        }
    )[-1]
    assert nested.content["parentToolCallId"] == "spawn"


@pytest.mark.parametrize(
    "name,shell_info", [("bash", None), ("powershell", None), ("native_alias", {})]
)
def test_native_shell_output_replaces_cumulative_snapshots(name, shell_info):
    mapper = EventMapper()
    started = mapper.map_event(
        sdk(
            "tool.execution_start", toolCallId="shell", toolName=name,
            arguments={"command": "printf safe"}, shellToolInfo=shell_info,
        )
    )
    assert started[-1].content["command"] == "printf safe"
    assert started[-1].content["output"] == ""
    snapshots = []
    for output in ("first\n", "first\nsecond\n", "first\nsecond\n"):
        snapshots.extend(
            mapper.map_event(
                sdk(
                    "tool.execution_partial_result",
                    toolCallId="shell",
                    partialOutput=output,
                )
            )
        )
    assert [event.content["output"] for event in snapshots] == [
        "first\n",
        "first\nsecond\n",
        "first\nsecond\n",
    ]


def test_completion_uses_authoritative_result_content_including_native_trailer():
    mapper = EventMapper()
    mapper.map_event(
        sdk("tool.execution_start", toolCallId="shell", toolName="bash")
    )
    mapper.map_event(
        sdk("tool.execution_partial_result", toolCallId="shell", partialOutput="first\n")
    )
    content = "first\nsecond\n<shellId: 0 completed with exit code 0>"
    events = mapper.map_event(
        sdk(
            "tool.execution_complete", toolCallId="shell", success=True,
            result={"content": content, "detailedContent": "different display text"},
            shellExecution={"exitCode": 0},
        )
    )
    assert events[0].content == content
    assert events[1].content["output"] == content
    assert "stdout" not in events[1].content and "stderr" not in events[1].content


@pytest.mark.parametrize("success", [True, False])
def test_final_activity_uses_lookup_result_or_actual_error_text(success):
    mapper = EventMapper()
    mapper.map_event(sdk("tool.execution_start", toolCallId="lookup", toolName="lookup_demo_status"))
    content = '{"label":"demo","status":"ready"}' if success else "Actual lookup error"
    events = mapper.map_event(sdk(
        "tool.execution_complete", toolCallId="lookup", success=success,
        **({"result": {"content": content}} if success else {"error": {"message": content}}),
    ))
    assert events[0].content == content
    assert events[1].content["output"] == content
    assert events[1].content["status"] == ("completed" if success else "error")


@pytest.mark.parametrize("parent", ["root-registry-only", "native-parent"])
@pytest.mark.parametrize("terminal", ["completed", "failed", "cancelled"])
def test_every_child_lifecycle_activity_serializes_its_top_level_scope(parent, terminal):
    mapper = EventMapper()
    if parent == "native-parent":
        mapper.map_event({
            "agentId": parent,
            **sdk("subagent.started", toolCallId="parent-spawn", agentName="parent"),
        })
    events = mapper.map_event({
        "agentId": "native-child",
        **sdk("subagent.started", toolCallId="child-spawn", agentName="child", parentId=parent),
    })
    events.extend(
        mapper.finish(cancelled=True, scope="child-spawn")
        if terminal == "cancelled"
        else mapper.map_event(sdk(f"subagent.{terminal}", toolCallId="child-spawn"))
    )
    activities = [
        event for event in dump(events)
        if event["type"] == "ACTIVITY_SNAPSHOT"
        and event["activityType"] == "copilot-sdk:subagent"
    ]
    assert len(activities) == 2
    assert all(event["subagentRunId"] == "child-spawn" for event in activities)
    assert all(event["content"]["agentName"] == "child" for event in activities)


def test_non_shell_prefix_growth_is_not_mistaken_for_a_cumulative_snapshot():
    mapper = EventMapper()
    started = mapper.map_event(
        sdk(
            "tool.execution_start", toolCallId="tool", toolName="stream_demo",
            arguments={"command": "not a native shell"},
        )
    )
    assert "command" not in started[-1].content
    for chunk in ("first\n", "first\nsecond\n"):
        events = mapper.map_event(
            sdk("tool.execution_partial_result", toolCallId="tool", partialOutput=chunk)
        )
    assert events[-1].content["output"] == "first\nfirst\nsecond\n"


def test_non_shell_repeated_output_chunks_remain_repeated():
    mapper = EventMapper()
    mapper.map_event(sdk("tool.execution_start", toolCallId="tool", toolName="stream_demo"))
    for _ in range(2):
        events = mapper.map_event(
            sdk(
                "tool.execution_partial_result",
                toolCallId="tool",
                partialOutput="line\n",
            )
        )
    assert events[-1].content["output"] == "line\nline\n"


def test_thousands_of_stream_events_do_not_spend_the_entity_budget():
    mapper = EventMapper()
    for index in range(5000):
        mapper.map_event({
            "id": f"delta-{index}",
            **sdk("assistant.message_delta", messageId="one", deltaContent="x"),
        })
    assert len(mapper.messages) == 1 and len(mapper.seen) == 5000
    assert len(mapper.messages["one"]["text"]) == 5000
    assert types(mapper.finish()) == ["TEXT_MESSAGE_END"]


def test_entity_and_dedup_limits_are_independent_and_fail_without_reset():
    mapper = EventMapper(max_items=1, max_events=2)
    first = {"id": "one", **sdk("assistant.message_delta", messageId="m", deltaContent="a")}
    mapper.map_event(first)
    mapper.map_event({"id": "two", **sdk("assistant.message_delta", messageId="m", deltaContent="b")})
    assert mapper.map_event(first) == []
    with pytest.raises(ValueError, match="deduplication limit"):
        mapper.map_event({"id": "three", **sdk("ignored")})
    assert mapper.messages["m"]["text"] == "ab"
    assert mapper.seen == {"one", "two"}
    with pytest.raises(ValueError, match="entity limit"):
        mapper.map_event(sdk("assistant.message_delta", messageId="new", deltaContent="x"))
    assert set(mapper.messages) == {"m"}


def test_late_closed_text_uses_a_new_segment_without_dropping_the_suffix():
    mapper = EventMapper()
    first = mapper.map_event(sdk("assistant.message_delta", messageId="m", deltaContent="before"))
    mapper.finish()
    later = mapper.map_event(sdk("assistant.message", messageId="m", content="before after"))
    assert types(later) == ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"]
    assert later[1].delta == " after"
    assert later[0].message_id != first[0].message_id


def test_late_tool_announcement_uses_its_new_wire_message_segment():
    mapper = EventMapper()
    mapper.map_event(sdk("assistant.message_delta", messageId="m", deltaContent="before"))
    mapper.finish()
    events = mapper.map_event(sdk(
        "assistant.message", messageId="m", content="before after",
        toolRequests=[{"toolCallId": "late", "name": "lookup", "arguments": {}}],
    ))
    message = next(event for event in events if event.type.value == "TEXT_MESSAGE_START")
    tool = next(event for event in events if event.type.value == "TOOL_CALL_START")
    assert message.message_id != "m"
    assert tool.parent_message_id == message.message_id


def test_unknown_explicit_subagent_parent_is_rejected_before_emission():
    mapper = EventMapper()
    with pytest.raises(ValueError, match="Unannounced subagent parent"):
        mapper.map_event({
            "agentId": "child-agent",
            **sdk(
                "subagent.started", toolCallId="spawn", agentName="child",
                parentToolCallId="unannounced",
            ),
        })
    assert not mapper.children and not mapper.agent_tool_calls


def test_unknown_child_tool_result_is_not_silently_attributed_to_root():
    mapper = EventMapper()
    with pytest.raises(ValueError, match="Unannounced subagent identity"):
        mapper.map_event({
            "agentId": "unannounced-child",
            **sdk(
                "tool.execution_complete", toolCallId="child-call", success=True,
                result={"content": "Actual child output"},
            ),
        })
    assert not mapper.tools and not mapper.children


@pytest.mark.parametrize("changed", ["agent", "spawn"])
def test_subagent_identity_cannot_be_rebound(changed):
    mapper = EventMapper()
    mapper.map_event({
        "agentId": "native-agent",
        **sdk("subagent.started", toolCallId="spawn", agentName="child"),
    })
    with pytest.raises(ValueError, match="Subagent identity changed"):
        mapper.map_event({
            "agentId": "different-agent" if changed == "agent" else "native-agent",
            **sdk(
                "subagent.started",
                toolCallId="different-spawn" if changed == "spawn" else "spawn",
                agentName="child",
            ),
        })
    assert mapper.agent_tool_calls == {"native-agent": "spawn"}


def test_child_text_reasoning_tools_and_activity_share_canonical_scope():
    mapper = EventMapper()
    mapper.map_event(
        {
            "agentId": "child-agent",
            **sdk("subagent.started", toolCallId="spawn", agentName="child"),
        }
    )
    events = mapper.map_event(
        {
            "agentId": "child-agent",
            **sdk("assistant.reasoning", reasoningId="r", content="Readable child"),
        }
    )
    message = mapper.map_event(
        {
            "agentId": "child-agent",
            **sdk(
                "assistant.message",
                messageId="m",
                content="Child tool call",
                parentToolCallId="legacy-must-not-override-agent",
                toolRequests=[{"toolCallId": "call", "name": "lookup", "arguments": {}}],
            ),
        }
    )
    events.extend(message)
    events.extend(
        mapper.map_event(
            sdk(
                "tool.execution_partial_result",
                toolCallId="call",
                partialOutput="progress\n",
            )
        )
    )
    events.extend(
        mapper.map_event(
            sdk(
                "tool.execution_complete",
                toolCallId="call",
                success=True,
                result={"content": "done"},
            )
        )
    )
    serialized = dump(events)
    assert all(event["subagentRunId"] == "spawn" for event in serialized)
    tool_start = next(event for event in serialized if event["type"] == "TOOL_CALL_START")
    assert tool_start["parentMessageId"] == "spawn:m"
    assert "legacy-must-not-override-agent" not in json.dumps(serialized)
    root = dump(mapper.map_event(sdk("assistant.message", messageId="root", content="Root")))
    assert all("subagentRunId" not in event for event in root)


def test_same_agent_name_invocations_remain_distinct_without_child_reasoning():
    mapper = EventMapper()
    events = mapper.map_event(
        sdk(
            "assistant.reasoning_delta",
            reasoningId="root-reasoning",
            deltaContent="Root only",
        )
    )
    for index in (1, 2):
        events.extend(
            mapper.map_event(
                {
                    "agentId": f"agent-{index}",
                    **sdk("subagent.started", toolCallId=f"spawn-{index}", agentName="same-agent"),
                }
            )
        )
    for index in (2, 1):
        events.extend(
            mapper.map_event(
                {
                    "agentId": f"agent-{index}",
                    **sdk(
                        "assistant.message_delta",
                        messageId="shared-message",
                        deltaContent=f"Child {index}",
                    ),
                }
            )
        )
        events.extend(
            mapper.map_event(
                {
                    "agentId": f"agent-{index}",
                    **sdk("subagent.completed", toolCallId=f"spawn-{index}"),
                }
            )
        )
    events.extend(mapper.finish())
    serialized = dump(events)
    starts = [event for event in serialized if event["type"] == "SUBAGENT_STARTED"]
    ends = [event for event in serialized if event["type"] == "SUBAGENT_FINISHED"]
    assert len(starts) == len(ends) == 2
    assert {event["name"] for event in starts} == {"same-agent"}
    assert len({event["subagentRunId"] for event in starts}) == 2
    assert {event["subagentRunId"] for event in starts} == {
        event["subagentRunId"] for event in ends
    }
    reasoning = [event for event in serialized if event["type"].startswith("REASONING_")]
    assert reasoning and all("subagentRunId" not in event for event in reasoning)
