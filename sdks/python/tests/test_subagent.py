import unittest

from ag_ui.core.types import AssistantMessage, ToolMessage, ReasoningMessage


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


if __name__ == "__main__":
    unittest.main()
