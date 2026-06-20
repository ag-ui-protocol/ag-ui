"""Tests for ``MessagesSnapshotEvent`` ``message_id`` rotation.

Regression: when a single ``run()`` produced multiple sequential tool calls
without intervening assistant text (e.g. backend tool followed by frontend
tool), the adapter wrote two ``AssistantMessage`` snapshot entries that
shared the same ``message_id``. Clients that key by ``id`` (CopilotKit v2)
deduped them and dropped the earlier entry, orphaning its tool result on
the next turn — OpenAI then rejected the resulting request with
``messages.[N].role 'tool' must follow tool_calls``.

Each AssistantMessage in the snapshot must carry a unique id.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from ag_ui.core import (
    AssistantMessage,
    EventType,
    RunAgentInput,
    Tool,
    UserMessage,
)
from strands.tools.registry import ToolRegistry

from ag_ui_strands.agent import StrandsAgent
from ag_ui_strands.config import StrandsAgentConfig


def _template_agent() -> MagicMock:
    mock = MagicMock()
    mock.model = MagicMock()
    mock.system_prompt = "You are helpful"
    mock.tool_registry.registry = {}
    mock.record_direct_tool_call = True
    return mock


def _build_agent(thread_id: str, stream_events: list) -> StrandsAgent:
    agent = StrandsAgent(
        _template_agent(), name="test-agent", config=StrandsAgentConfig()
    )
    mock_inner = MagicMock()
    mock_inner.tool_registry = ToolRegistry()
    mock_inner.session_manager = None

    async def _stream(_msg):
        for event in stream_events:
            yield event

    mock_inner.stream_async = _stream
    agent._agents_by_thread[thread_id] = mock_inner
    return agent


async def _collect(agent: StrandsAgent, inp: RunAgentInput) -> list:
    return [e async for e in agent.run(inp)]


class TestSequentialToolCallsHaveDistinctMessageIds:
    """Two tool calls in one run, no text between, must produce two
    AssistantMessage snapshot entries with distinct ``id`` values."""

    THREAD = "seq-tools-thread"
    # One backend tool (no entry in tools list) followed by one frontend tool.
    TOOLS = [Tool(name="frontend_tool", description="f", parameters={})]
    STREAM = [
        # Backend tool call
        {"current_tool_use": {"name": "backend_tool", "toolUseId": "st-backend", "input": {}}},
        {"event": {"contentBlockStop": {}}},
        # Backend result arrives — should not halt (no stop_streaming behavior)
        {
            "message": {
                "role": "user",
                "content": [
                    {
                        "toolResult": {
                            "toolUseId": "st-backend",
                            "content": [{"text": '{"ok": true}'}],
                        }
                    }
                ],
            }
        },
        # Frontend tool call follows directly — no text between
        {"current_tool_use": {"name": "frontend_tool", "toolUseId": "st-frontend", "input": {}}},
        {"event": {"contentBlockStop": {}}},
    ]

    async def test_each_tool_call_has_distinct_assistant_message_id(self):
        agent = _build_agent(self.THREAD, self.STREAM)
        inp = RunAgentInput(
            thread_id=self.THREAD,
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="do both")],
            tools=self.TOOLS,
            context=[],
            forwarded_props={},
        )
        events = await _collect(agent, inp)

        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        assert snapshots, "expected at least one MessagesSnapshotEvent"

        final = snapshots[-1].messages
        tool_call_assistants = [
            m
            for m in final
            if isinstance(m, AssistantMessage) and m.tool_calls
        ]
        assert len(tool_call_assistants) == 2, (
            f"expected 2 assistant messages with tool_calls, got "
            f"{len(tool_call_assistants)}"
        )

        ids = [m.id for m in tool_call_assistants]
        assert len(set(ids)) == len(ids), (
            f"tool-call assistant messages must have distinct ids; got {ids}"
        )

    async def test_tool_call_start_parent_ids_match_snapshot_ids(self):
        """The ``parent_message_id`` on each TOOL_CALL_START must match the
        ``id`` of the corresponding AssistantMessage in the snapshot."""
        agent = _build_agent(self.THREAD + "-link", self.STREAM)
        inp = RunAgentInput(
            thread_id=self.THREAD + "-link",
            run_id="r1",
            state={},
            messages=[UserMessage(id="u1", content="do both")],
            tools=self.TOOLS,
            context=[],
            forwarded_props={},
        )
        events = await _collect(agent, inp)

        starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
        snapshots = [e for e in events if e.type == EventType.MESSAGES_SNAPSHOT]
        final = snapshots[-1].messages

        # Build {tool_call_id: parent_message_id} from wire events.
        wire_pairs = {e.tool_call_id: e.parent_message_id for e in starts}

        # Build {tool_call_id: assistant_message_id} from snapshot.
        snap_pairs = {}
        for m in final:
            if isinstance(m, AssistantMessage) and m.tool_calls:
                for tc in m.tool_calls:
                    snap_pairs[tc.id] = m.id

        for tc_id, parent_id in wire_pairs.items():
            assert tc_id in snap_pairs, (
                f"tool_call {tc_id} present on wire but missing from snapshot"
            )
            assert snap_pairs[tc_id] == parent_id, (
                f"tool_call {tc_id}: wire parent_message_id={parent_id} "
                f"!= snapshot assistant id={snap_pairs[tc_id]}"
            )
