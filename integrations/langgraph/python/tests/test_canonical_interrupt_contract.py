"""Exercise the supported wire contract against an actual checkpointed graph."""
import unittest
from typing import Any

from ag_ui.core import EventType, RunAgentInput, ResumeEntry, UserMessage
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, END, MessagesState, StateGraph
from langgraph.types import interrupt
from pydantic import ValidationError

from ag_ui_langgraph import LangGraphAgent


class ApprovalState(MessagesState):
    answer: Any


def make_input(run_id, **kwargs):
    return RunAgentInput(
        thread_id="approval", run_id=run_id, state={}, tools=[], context=[],
        messages=[UserMessage(id="u1", role="user", content="approve")],
        forwarded_props=kwargs.pop("forwarded_props", {}), **kwargs,
    )


class TestCanonicalInterruptContract(unittest.IsolatedAsyncioTestCase):
    async def test_checkpoint_replay_and_native_resume_preserve_falsy_payloads(self):
        for payload in (False, 0, "", []):
            with self.subTest(payload=payload):
                def approve(state):
                    return {"answer": interrupt({"reason": "approval", "message": "Proceed?"})}

                builder = StateGraph(ApprovalState)
                builder.add_node("approve", approve)
                builder.add_edge(START, "approve")
                builder.add_edge("approve", END)
                graph = builder.compile(checkpointer=MemorySaver())
                agent = LangGraphAgent(name="approval", graph=graph)
                first = [e async for e in agent.run(make_input("first"))]
                self.assertEqual(first[-1].type, EventType.RUN_FINISHED)
                self.assertEqual(first[-1].outcome.type, "interrupt")
                iid = first[-1].outcome.interrupts[0].id
                self.assertFalse(any(getattr(e, "name", None) == "on_interrupt" for e in first))

                replay = [e async for e in agent.run(make_input(
                    "legacy", forwarded_props={"command": {"resume": "ignored"}},
                ))]
                self.assertEqual(replay[-1].outcome.interrupts[0].id, iid)

                resumed = [e async for e in agent.run(make_input(
                    "resumed", resume=[ResumeEntry(interrupt_id=iid, status="resolved", payload=payload)],
                ))]
                self.assertEqual(resumed[-1].type, EventType.RUN_FINISHED)
                self.assertNotEqual(getattr(resumed[-1].outcome, "type", None), "interrupt")
                snapshot = await graph.aget_state({"configurable": {"thread_id": "approval"}})
                self.assertEqual(snapshot.values["answer"], payload)
                self.assertFalse(snapshot.next)

    def test_binary_wire_input_is_rejected_by_protocol(self):
        data = make_input("invalid").model_dump()
        data["messages"] = [{"id": "u1", "role": "user", "content": [
            {"type": "binary", "mimeType": "image/png", "data": "AAAA"},
        ]}]
        with self.assertRaises(ValidationError):
            RunAgentInput.model_validate(data)

    def test_removed_interrupt_flags_are_rejected(self):
        for flag in ("enable_legacy_on_interrupt_event", "emit_interrupt_outcome"):
            with self.subTest(flag=flag), self.assertRaises(TypeError):
                LangGraphAgent(name="invalid", graph=None, **{flag: True})
