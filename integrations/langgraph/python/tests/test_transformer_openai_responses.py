"""Lossless inversion of provider-backed OpenAI Responses block indices."""
import copy
import unittest

from langchain_core.messages import AIMessage
from langchain_core.messages.block_translators.openai import _convert_to_v1_from_responses

from ag_ui_langgraph.transformer import _openai_responses_v2_message


class TestOpenAIResponsesProjection(unittest.TestCase):
    def message(self, content):
        original = AIMessage(
            id="resp-provider", content=content,
            response_metadata={"model_provider": "openai", "object": "response", "id": "resp-provider"},
            usage_metadata={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3, "input_token_details": {}, "output_token_details": {}},
        )
        native = original.model_dump()
        native["id"] = "stream-run"
        native["response_metadata"] = {**native["response_metadata"], "output_version": "v1"}
        native["content"] = _convert_to_v1_from_responses(original)
        return original.model_dump(), native

    def test_round_trips_provider_indices_ids_and_multiple_summaries(self):
        original, native = self.message([
            {"type": "reasoning", "id": "rs-provider", "index": 4,
             "summary": [{"index": 2, "type": "summary_text", "text": "First"},
                         {"index": 5, "type": "summary_text", "text": "Second"}],
             "encrypted_content": "opaque-provider-ciphertext"},
            {"type": "text", "id": "msg-provider", "index": 7, "text": "Answer"},
        ])
        before = copy.deepcopy(native)
        projected = _openai_responses_v2_message(native)
        self.assertEqual(original, projected)
        self.assertEqual(before, native)
        self.assertEqual("rs-provider", projected["content"][0]["id"])

    def test_preserves_encrypted_reasoning_with_empty_summary(self):
        original, native = self.message([
            {"type": "reasoning", "id": "rs-private", "index": 8, "summary": [],
             "encrypted_content": "opaque"},
        ])
        self.assertEqual(original, _openai_responses_v2_message(native))

    def test_missing_indices_and_other_providers_are_not_guessed(self):
        _, native = self.message([
            {"type": "reasoning", "id": "rs-provider", "index": 0,
             "summary": [{"index": 0, "type": "summary_text", "text": "Summary"}]},
        ])
        for index in [0, "lc_rs_invalid", "lc_rs_6e6f745f696e646578", "unrelated"]:
            with self.subTest(index=index):
                candidate = copy.deepcopy(native)
                candidate["content"][0]["index"] = index
                self.assertIs(candidate, _openai_responses_v2_message(candidate))
        native["response_metadata"]["model_provider"] = "anthropic"
        self.assertIs(native, _openai_responses_v2_message(native))

    def test_unsupported_rich_or_redacted_blocks_remain_intact(self):
        for block in [
            {"type": "redacted_thinking", "data": "ciphertext", "index": 0},
            {"type": "image", "url": "https://example.test/image.png", "index": 1},
            {"type": "text", "text": "Citation", "index": "lc_txt_1", "annotations": [{"type": "citation", "url": "https://example.test"}]},
        ]:
            native = {"type": "ai", "id": "run", "content": [block],
                      "response_metadata": {"model_provider": "openai", "object": "response", "output_version": "v1"}}
            self.assertIs(native, _openai_responses_v2_message(native))

    def test_usage_details_are_preserved_and_missing_maps_are_explicit(self):
        _, native = self.message([{ "type": "text", "text": "Answer", "index": 1 }])
        native["usage_metadata"] = {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3,
                                    "output_token_details": {"reasoning": 2}}
        projected = _openai_responses_v2_message(native)
        self.assertEqual({}, projected["usage_metadata"]["input_token_details"])
        self.assertEqual({"reasoning": 2}, projected["usage_metadata"]["output_token_details"])


    def test_state_and_messages_snapshots_share_provider_identity_without_mutating_graph_state(self):
        from ag_ui_langgraph.transformer import agui_transformer
        original, native = self.message([
            {"type": "reasoning", "id": "rs-provider", "index": 0,
             "summary": [{"index": 0, "type": "summary_text", "text": "Summary"}]},
            {"type": "text", "id": "msg-provider", "index": 1, "text": "Answer"},
        ])
        message = AIMessage.model_validate(native)
        before = message.model_dump()
        transformer = agui_transformer()
        events = []
        transformer.init()["agui"].push = events.append
        transformer.process({"type": "event", "method": "values", "params": {
            "namespace": [], "data": {"messages": [message]}}})
        transformer.finalize()
        state = next(event["snapshot"] for event in events if event["type"] == "STATE_SNAPSHOT")
        self.assertEqual(original, state["messages"][0])
        messages = next(event["messages"] for event in events if event["type"] == "MESSAGES_SNAPSHOT")
        self.assertEqual(["rs-provider", "resp-provider"], [item["id"] for item in messages])
        self.assertEqual(before, message.model_dump())
