"""End-to-end wiring: OnChatModelStream usage_metadata -> RUN_FINISHED.usage.

Drives the real `_handle_single_event` chunk handler with fake final chunks
(carrying `usage_metadata` + `finish_reason`, as LangChain delivers them) and
asserts the terminal event produced by `_emit_success_finish` carries the
aggregated usage.
"""
import asyncio
import unittest

from ag_ui.core import EventType

from tests._helpers import make_agent


class _FakeFinalChunk:
    """Stand-in for a LangChain AIMessageChunk final chunk (attribute access)."""

    def __init__(self, usage_metadata):
        self.response_metadata = {"finish_reason": "stop"}
        self.tool_call_chunks = []
        self.usage_metadata = usage_metadata
        self.content = ""
        self.id = "msg-1"


def _finish_event(usage_metadata, provider, model):
    return {
        "event": "on_chat_model_stream",
        "metadata": {
            "ls_provider": provider,
            "ls_model_name": model,
            "emit-messages": True,
            "emit-tool-calls": True,
        },
        "data": {"chunk": _FakeFinalChunk(usage_metadata)},
    }


def _feed(agent, event):
    async def drain():
        async for _ in agent._handle_single_event(event, {}):
            pass

    asyncio.run(drain())


class RunFinishedUsageWiringTest(unittest.TestCase):
    def _fresh_agent(self):
        agent = make_agent()
        agent.active_run = {"id": "run-1", "usage": []}
        agent.messages_in_process = {}
        return agent

    def test_single_call_usage_reaches_run_finished(self):
        agent = self._fresh_agent()
        _feed(
            agent,
            _finish_event(
                {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
                provider="anthropic",
                model="claude-sonnet-4",
            ),
        )
        event = agent._emit_success_finish(thread_id="t-1", run_id="run-1")
        self.assertEqual(event.type, EventType.RUN_FINISHED)
        self.assertIsNotNone(event.usage)
        self.assertEqual(len(event.usage), 1)
        self.assertEqual(event.usage[0].provider, "anthropic")
        self.assertEqual(event.usage[0].total_tokens, 150)

    def test_multiple_calls_same_model_are_aggregated(self):
        agent = self._fresh_agent()
        for _ in range(2):
            _feed(
                agent,
                _finish_event(
                    {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
                    provider="openai",
                    model="gpt-4o",
                ),
            )
        event = agent._emit_success_finish(thread_id="t-1", run_id="run-1")
        self.assertEqual(len(event.usage), 1)
        self.assertEqual(event.usage[0].input_tokens, 200)
        self.assertEqual(event.usage[0].total_tokens, 240)

    def test_run_without_usage_omits_field(self):
        agent = self._fresh_agent()
        event = agent._emit_success_finish(thread_id="t-1", run_id="run-1")
        self.assertIsNone(event.usage)


if __name__ == "__main__":
    unittest.main()
