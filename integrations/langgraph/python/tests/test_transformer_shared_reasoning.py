"""Provider reasoning IDs can span several content-block indices."""
import unittest
from langchain_core.messages import AIMessage
from ag_ui_langgraph.utils import langchain_messages_to_agui
from tests.test_agui_transformer import Harness, requires_stream_api

@requires_stream_api
class TestSharedReasoning(unittest.TestCase):
    def test_overlapping_blocks_share_lifecycle(self):
        for partial in [False, True]:
            with self.subTest(partial=partial):
                h = Harness()
                h.msg({"event": "message-start", "id": "answer"})
                for index, text in enumerate(["First", "Second"]):
                    h.msg({"event": "content-block-start", "index": index,
                           "content": {"type": "reasoning", "id": "rs_same", "reasoning": text}})
                self.assertEqual(1, sum(e["type"] == "REASONING_START" for e in h.wire_events))
                if partial:
                    h.msg({"event": "content-block-finish", "index": 0, "content": {"type": "reasoning"}})
                    self.assertFalse(any(e["type"] == "REASONING_END" for e in h.wire_events))
                    h.msg({"event": "content-block-delta", "index": 1, "delta": {"type": "reasoning-delta", "reasoning": "Tail"}})
                h.transformer.finalize()
                for kind in ["REASONING_START", "REASONING_END", "REASONING_MESSAGE_START", "REASONING_MESSAGE_END"]:
                    self.assertEqual(["rs_same"], [e["messageId"] for e in h.wire_events if e["type"] == kind])

    def test_snapshot_merges_summary_parts_and_encryption(self):
        result = langchain_messages_to_agui([AIMessage(id="answer", content=[
            {"type": "reasoning", "id": "rs_same", "summary": [{"type": "summary_text", "text": "First"}]},
            {"type": "reasoning", "id": "rs_same", "summary": [{"type": "summary_text", "text": "Second"}], "encrypted_content": "encrypted"},
        ])])
        reasoning = [m for m in result if m.role == "reasoning"]
        self.assertEqual(1, len(reasoning))
        self.assertEqual("rs_same", reasoning[0].id)
        self.assertEqual("First\nSecond", reasoning[0].content)
        self.assertEqual("encrypted", reasoning[0].encrypted_value)

    def test_empty_shared_blocks_close_once_on_message_error(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "answer"})
        for index in [0, 1]:
            h.msg({"event": "content-block-start", "index": index,
                   "content": {"type": "reasoning", "id": "rs_same"}})
        h.msg({"event": "message-error"})
        h.transformer.finalize()
        self.assertEqual(["REASONING_START", "REASONING_END"],
                         [e["type"] for e in h.wire_events if e["type"].startswith("REASONING")])

    def test_sequential_shared_blocks_keep_provider_identity(self):
        h = Harness()
        h.msg({"event": "message-start", "id": "answer"})
        for index, text in enumerate(["First", "Second"]):
            h.msg({"event": "content-block-start", "index": index,
                   "content": {"type": "reasoning", "id": "rs_same", "reasoning": text}})
            h.msg({"event": "content-block-finish", "index": index,
                   "content": {"type": "reasoning"}})
        h.transformer.finalize()
        for kind in ["REASONING_START", "REASONING_END"]:
            self.assertEqual(["rs_same", "rs_same"],
                             [e["messageId"] for e in h.wire_events if e["type"] == kind])
        self.assertEqual(["First", "Second"], [e["delta"] for e in h.wire_events
                                              if e["type"] == "REASONING_MESSAGE_CONTENT"])
