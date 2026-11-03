# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.
"""AG-UI 1.0 content parts and roles, narrowed for both Agent Spec runtimes.

1.0 clients send ``ContentPart[]`` on user and tool messages and send
``developer``, ``activity`` and ``reasoning`` messages in ordinary
conversations. Neither LangGraph nor WayFlow takes those as-is, so both runners
flatten parts to text and map or drop the extra roles instead of crashing.
"""

import logging

import pytest

from ag_ui.core import (
    ActivityMessage,
    AssistantMessage,
    DeveloperMessage,
    FileSource,
    ImagePart,
    ReasoningMessage,
    SystemMessage,
    TextPart,
    ToolMessage,
    UrlSource,
    UserMessage,
)
from wayflowcore.messagelist import MessageType

from ag_ui_agentspec.message_content import content_to_text
from ag_ui_agentspec.runtimes.langgraph_runner import prepare_langgraph_agent_inputs
from ag_ui_agentspec.runtimes.wayflow_runner import (
    prepare_wayflow_agent_input,
    prepare_wayflow_flow_input,
)


def _parts_with_media():
    return [
        TextPart(text="look at "),
        ImagePart(source=UrlSource(value="https://example.com/cat.png")),
        TextPart(text="this"),
    ]


def _parts_with_file_handle():
    return [
        TextPart(text="summarise the upload"),
        ImagePart(source=FileSource(value="file-abc123", provider="openai")),
    ]


def _conversation_with_every_role():
    return [
        SystemMessage(id="s", content="be nice"),
        DeveloperMessage(id="d", content="answer in French"),
        UserMessage(id="u", content=[TextPart(text="bonjour")]),
        ReasoningMessage(id="r", content="the user greeted me"),
        AssistantMessage(id="a", content="salut"),
        ActivityMessage(id="act", activity_type="PLAN", content={"steps": []}),
        ToolMessage(id="t", tool_call_id="tc1", content=[TextPart(text="42")]),
    ]


class TestContentToText:
    def test_string_passes_through(self):
        assert content_to_text("hi") == "hi"

    def test_none_becomes_empty_string(self):
        assert content_to_text(None) == ""

    def test_text_parts_are_concatenated(self):
        assert content_to_text([TextPart(text="a"), TextPart(text="b")]) == "ab"

    def test_dumped_parts_are_accepted(self):
        # The runners narrow model_dump() output, where parts are plain dicts.
        dumped = [p.model_dump() for p in _parts_with_media()]
        assert content_to_text(dumped) == "look at this"

    def test_media_part_is_skipped_with_warning(self, caplog):
        with caplog.at_level(logging.WARNING, logger="ag_ui_agentspec.tracing"):
            assert content_to_text(_parts_with_media(), message_id="m1") == "look at this"
        assert "'image'" in caplog.text
        assert "m1" in caplog.text

    def test_file_source_part_is_skipped_with_warning(self, caplog):
        with caplog.at_level(logging.WARNING, logger="ag_ui_agentspec.tracing"):
            text = content_to_text(_parts_with_file_handle(), message_id="m2")
        assert text == "summarise the upload"
        assert "FileSource" in caplog.text
        # The handle is opaque; it must never be forwarded as text or a URL.
        assert "file-abc123" not in text


class TestLangGraphRunnerNarrowing:
    def test_every_role_in_one_conversation(self, make_input):
        out = prepare_langgraph_agent_inputs(
            make_input(messages=_conversation_with_every_role())
        )
        assert [(m["id"], m["role"], m["content"]) for m in out] == [
            ("s", "system", "be nice"),
            ("d", "system", "answer in French"),
            ("u", "user", "bonjour"),
            ("a", "assistant", "salut"),
            ("t", "tool", "42"),
        ]

    def test_output_is_accepted_by_langchain(self, make_input):
        """The narrowed dicts must coerce to LangChain messages, which is what the graph does."""
        from langchain_core.messages import convert_to_messages

        out = prepare_langgraph_agent_inputs(
            make_input(messages=_conversation_with_every_role())
        )
        assert [type(m).__name__ for m in convert_to_messages(out)] == [
            "SystemMessage",
            "SystemMessage",
            "HumanMessage",
            "AIMessage",
            "ToolMessage",
        ]


class TestWayflowRunnerNarrowing:
    def test_every_role_in_one_conversation(self, make_input):
        out = prepare_wayflow_agent_input(make_input(messages=_conversation_with_every_role()))
        # Index 3 is the assistant turn; its WayFlow type is derived from its
        # tool_requests, which is unrelated to the narrowing under test.
        assert [out[i].message_type for i in (0, 1, 2, 4)] == [
            MessageType.SYSTEM,
            MessageType.SYSTEM,
            MessageType.USER,
            MessageType.TOOL_RESULT,
        ]
        assert [m.content for m in out[:4]] == ["be nice", "answer in French", "bonjour", "salut"]
        assert out[4].tool_result.content == "42"

    def test_flow_input_narrows_array_content(self, make_input):
        inp = make_input(messages=[UserMessage(id="u", content=_parts_with_media())])
        assert prepare_wayflow_flow_input(inp) == {"user_input": "look at this"}

    def test_flow_input_ignores_trailing_activity_and_reasoning(self, make_input):
        inp = make_input(
            messages=[
                UserMessage(id="u", content="plan my day"),
                ReasoningMessage(id="r", content="thinking"),
                ActivityMessage(id="act", activity_type="PLAN", content={"steps": []}),
            ]
        )
        assert prepare_wayflow_flow_input(inp) == {"user_input": "plan my day"}

    def test_flow_input_takes_the_last_user_turn(self, make_input):
        inp = make_input(
            messages=[
                UserMessage(id="u1", content="first question"),
                AssistantMessage(id="a1", content="first answer"),
                UserMessage(id="u2", content="question"),
                AssistantMessage(id="a2", content="answer"),
                ReasoningMessage(id="r", content="thinking"),
            ]
        )
        assert prepare_wayflow_flow_input(inp) == {"user_input": "question"}

    def test_flow_input_without_a_user_message_fails_clearly(self, make_input):
        inp = make_input(messages=[ReasoningMessage(id="r", content="thinking")])
        with pytest.raises(ValueError, match="needs a user message"):
            prepare_wayflow_flow_input(inp)
