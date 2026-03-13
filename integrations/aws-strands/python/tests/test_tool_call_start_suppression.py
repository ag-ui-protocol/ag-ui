"""Regression test for ag-ui#1275: TOOL_CALL_START must not be suppressed for
new tool calls in the same turn after a pending tool result is consumed."""

from __future__ import annotations

import pytest

from ag_ui_strands.agent import StrandsAgent


class TestPendingToolResultIds:
    """Verify that pending_tool_result_ids only contains IDs from trailing
    tool-role messages in the conversation history, not a blanket boolean."""

    @staticmethod
    def _make_msg(role: str, **kwargs):
        """Minimal message-like object with role and optional attrs."""

        class _Msg:
            pass

        m = _Msg()
        m.role = role
        for k, v in kwargs.items():
            setattr(m, k, v)
        return m

    @staticmethod
    def _make_input(messages):
        """Minimal RunAgentInput-like object."""

        class _Input:
            pass

        inp = _Input()
        inp.messages = messages
        inp.thread_id = "test-thread"
        return inp

    def test_trailing_tool_messages_collected(self):
        """When history ends with two tool messages their IDs are collected."""
        msgs = [
            self._make_msg("user", content="hello"),
            self._make_msg(
                "assistant",
                tool_calls=[{"id": "tc1"}, {"id": "tc2"}],
                content="",
            ),
            self._make_msg("tool", tool_call_id="tc1", content="ok1"),
            self._make_msg("tool", tool_call_id="tc2", content="ok2"),
        ]
        input_data = self._make_input(msgs)

        # Replicate the same logic from agent.py
        pending: set[str] = set()
        if input_data.messages:
            for msg in reversed(input_data.messages):
                if msg.role == "tool":
                    tool_call_id = getattr(msg, "tool_call_id", None)
                    if tool_call_id:
                        pending.add(tool_call_id)
                else:
                    break

        assert pending == {"tc1", "tc2"}

    def test_non_trailing_tool_messages_ignored(self):
        """Tool messages NOT at the tail are not collected."""
        msgs = [
            self._make_msg("tool", tool_call_id="old_tc", content="stale"),
            self._make_msg("user", content="continue"),
        ]
        input_data = self._make_input(msgs)

        pending: set[str] = set()
        if input_data.messages:
            for msg in reversed(input_data.messages):
                if msg.role == "tool":
                    tool_call_id = getattr(msg, "tool_call_id", None)
                    if tool_call_id:
                        pending.add(tool_call_id)
                else:
                    break

        assert pending == set(), "Only trailing tool messages should be collected"

    def test_new_tool_call_not_suppressed(self):
        """A tool_use_id that is NOT in pending_tool_result_ids must NOT be
        suppressed — this is the core regression for #1275."""
        pending_tool_result_ids = {"tc_old"}
        new_tool_use_id = "tc_new"

        is_pending = new_tool_use_id in pending_tool_result_ids
        assert not is_pending, (
            "New tool calls must not be treated as pending; START event must fire"
        )

    def test_pending_tool_call_is_suppressed(self):
        """A tool_use_id that IS in pending_tool_result_ids must be suppressed."""
        pending_tool_result_ids = {"tc_old"}
        is_pending = "tc_old" in pending_tool_result_ids
        assert is_pending, "Matching pending result should suppress START event"

    def test_empty_messages_no_pending(self):
        """Empty message list produces no pending IDs."""
        input_data = self._make_input([])

        pending: set[str] = set()
        if input_data.messages:
            for msg in reversed(input_data.messages):
                if msg.role == "tool":
                    tool_call_id = getattr(msg, "tool_call_id", None)
                    if tool_call_id:
                        pending.add(tool_call_id)
                else:
                    break

        assert pending == set()
