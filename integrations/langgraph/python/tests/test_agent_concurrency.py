import asyncio
import unittest
from types import SimpleNamespace

from ag_ui_langgraph.agent import LangGraphAgent


class _FakeGraph:
    async def aget_state(self, config):
        return SimpleNamespace(values={}, tasks=[], metadata={}, next=[])


async def _empty_stream():
    if False:
        yield None


class TestLangGraphAgentConcurrency(unittest.TestCase):
    def test_concurrent_runs_keep_per_request_state_isolated(self):
        async def collect_first_event(agent, run_id, entered, ready, visible_keys):
            async def fake_prepare_stream(*, input, agent_state, config):
                agent.set_message_in_progress(run_id, {"id": run_id})
                entered.append(run_id)
                if len(entered) == 2:
                    ready.set()
                await ready.wait()
                visible_keys[run_id] = sorted(agent.messages_in_process.keys())
                return {"state": {}, "stream": _empty_stream(), "config": config}

            agent.prepare_stream = fake_prepare_stream
            gen = agent._handle_stream_events(
                SimpleNamespace(
                    thread_id=f"thread-{run_id}",
                    run_id=run_id,
                    forwarded_props={},
                )
            )
            try:
                first = await gen.__anext__()
                return {
                    "run_id": getattr(first, "run_id", None),
                    "thread_id": getattr(first, "thread_id", None),
                }
            finally:
                await gen.aclose()

        async def run_test():
            agent = LangGraphAgent(name="test", graph=_FakeGraph())
            entered = []
            ready = asyncio.Event()
            visible_keys = {}
            first_a, first_b = await asyncio.gather(
                collect_first_event(agent, "run-a", entered, ready, visible_keys),
                collect_first_event(agent, "run-b", entered, ready, visible_keys),
            )
            return first_a, first_b, visible_keys

        first_a, first_b, visible_keys = asyncio.run(run_test())

        self.assertEqual(first_a["run_id"], "run-a")
        self.assertEqual(first_a["thread_id"], "thread-run-a")
        self.assertEqual(first_b["run_id"], "run-b")
        self.assertEqual(first_b["thread_id"], "thread-run-b")
        self.assertEqual(visible_keys["run-a"], ["run-a"])
        self.assertEqual(visible_keys["run-b"], ["run-b"])
