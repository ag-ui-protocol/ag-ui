import unittest

from ag_ui.core.types import AssistantMessage, ToolMessage, ReasoningMessage
from ag_ui.core.events import (
    EventType,
    TextMessageStartEvent,
    StateDeltaEvent,
    SubagentStartedEvent,
    SubagentFinishedEvent,
    SubagentErrorEvent,
)


class TestSubagentMessageAttribution(unittest.TestCase):
    def test_assistant_message_accepts_subagent_id(self):
        msg = AssistantMessage(id="m1", role="assistant", content="hi", subagent_id="sub-1")
        self.assertEqual(msg.subagent_id, "sub-1")
        self.assertEqual(msg.model_dump(by_alias=True)["subagentId"], "sub-1")

    def test_tool_and_reasoning_messages_accept_subagent_id(self):
        tool = ToolMessage(id="t1", role="tool", content="ok", tool_call_id="tc1", subagent_id="sub-2")
        self.assertEqual(tool.subagent_id, "sub-2")
        reasoning = ReasoningMessage(id="r1", role="reasoning", content="x", subagent_id="sub-3")
        self.assertEqual(reasoning.subagent_id, "sub-3")

    def test_subagent_id_optional(self):
        msg = AssistantMessage(id="m2", role="assistant", content="hi")
        self.assertIsNone(msg.subagent_id)


class TestSubagentEventAttribution(unittest.TestCase):
    def test_creation_and_standalone_events_accept_subagent_id(self):
        e = TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m1", subagent_id="sub-1")
        self.assertEqual(e.subagent_id, "sub-1")
        self.assertEqual(e.model_dump(by_alias=True)["subagentId"], "sub-1")
        d = StateDeltaEvent(type=EventType.STATE_DELTA, delta=[], subagent_id="sub-2")
        self.assertEqual(d.subagent_id, "sub-2")


class TestSubagentLifecycleEvents(unittest.TestCase):
    def test_started_finished_error(self):
        s = SubagentStartedEvent(
            type=EventType.SUBAGENT_STARTED, subagent_id="s1", name="R",
            description="d", parent_subagent_id="s0",
        )
        self.assertEqual(s.type, EventType.SUBAGENT_STARTED)
        self.assertEqual(s.parent_subagent_id, "s0")
        f = SubagentFinishedEvent(type=EventType.SUBAGENT_FINISHED, subagent_id="s1")
        self.assertEqual(f.type, EventType.SUBAGENT_FINISHED)
        err = SubagentErrorEvent(type=EventType.SUBAGENT_ERROR, subagent_id="s1", message="boom", code="E1")
        self.assertEqual(err.message, "boom")


if __name__ == "__main__":
    unittest.main()
