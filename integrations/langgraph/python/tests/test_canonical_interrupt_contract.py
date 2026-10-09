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
        for payload in (False, 0, "", [], {}, None):
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


class TestCheckpointResumeIdentity(unittest.IsolatedAsyncioTestCase):
    async def test_wrong_or_duplicate_ids_do_not_change_checkpoint_after_reconnect(self):
        def approve(state):
            return {"answer": interrupt("Proceed?")}

        graph = (StateGraph(ApprovalState).add_node("approve", approve)
                 .add_edge(START, "approve").add_edge("approve", END)
                 .compile(checkpointer=MemorySaver()))
        agent = LangGraphAgent(name="approval", graph=graph)
        first = [e async for e in agent.run(make_input("first"))]
        iid = first[-1].outcome.interrupts[0].id
        config = {"configurable": {"thread_id": "approval"}}
        original = await graph.aget_state(config)
        for ids in (["definitely-wrong"], [iid, iid], [iid, "stale"]):
            with self.subTest(ids=ids):
                fresh = LangGraphAgent(name="approval", graph=graph)
                events = [e async for e in fresh.run(make_input("invalid", resume=[
                    ResumeEntry(interrupt_id=i, status="resolved", payload=True) for i in ids
                ]))]
                self.assertEqual(events[-1].type, EventType.RUN_ERROR)
                self.assertIn("interrupt", events[-1].message.lower())
                unchanged = await graph.aget_state(config)
                self.assertEqual(unchanged.config, original.config)
                self.assertEqual(unchanged.values, original.values)
                self.assertEqual(unchanged.next, original.next)
        fresh = LangGraphAgent(name="approval", graph=graph)
        events = [e async for e in fresh.run(make_input("valid", resume=[
            ResumeEntry(interrupt_id=iid, status="resolved", payload=False)
        ]))]
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        self.assertIs((await graph.aget_state(config)).values["answer"], False)
        replay = [e async for e in fresh.run(make_input("replay", resume=[
            ResumeEntry(interrupt_id=iid, status="resolved", payload=True)
        ]))]
        self.assertEqual(replay[-1].type, EventType.RUN_ERROR)
        self.assertIs((await graph.aget_state(config)).values["answer"], False)

    async def test_parallel_interrupts_receive_their_own_answers_after_reconnect(self):
        class ParallelState(MessagesState):
            left: Any
            right: Any

        def left(state):
            return {"left": interrupt("left?")}

        def right(state):
            return {"right": interrupt("right?")}

        for partial in (False, True):
            with self.subTest(partial=partial):
                graph = (StateGraph(ParallelState)
                         .add_node("left", left).add_node("right", right)
                         .add_edge(START, "left").add_edge(START, "right")
                         .add_edge("left", END).add_edge("right", END)
                         .compile(checkpointer=MemorySaver()))
                agent = LangGraphAgent(name="approval", graph=graph)
                first = [e async for e in agent.run(make_input("first"))]
                pending = {i.message: i.id for i in first[-1].outcome.interrupts}
                answers = [("right?", {"approved": True}), ("left?", False)]
                batches = [[a] for a in answers] if partial else [answers]
                for n, batch in enumerate(batches):
                    fresh = LangGraphAgent(name="approval", graph=graph)
                    events = [e async for e in fresh.run(make_input(str(n), resume=[
                        ResumeEntry(interrupt_id=pending[key], status="resolved", payload=value)
                        for key, value in batch
                    ]))]
                    self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
                result = await graph.aget_state({"configurable": {"thread_id": "approval"}})
                self.assertIs(result.values["left"], False)
                self.assertEqual(result.values["right"], {"approved": True})
                self.assertFalse(result.next)


    async def test_parallel_cancellation_reaches_only_its_own_interrupt(self):
        class ParallelState(MessagesState):
            left: Any
            right: Any

        graph = (StateGraph(ParallelState)
                 .add_node("left", lambda state: {"left": interrupt("left?")})
                 .add_node("right", lambda state: {"right": interrupt("right?")})
                 .add_edge(START, "left").add_edge(START, "right")
                 .add_edge("left", END).add_edge("right", END)
                 .compile(checkpointer=MemorySaver()))
        agent = LangGraphAgent(name="approval", graph=graph)
        first = [e async for e in agent.run(make_input("first"))]
        pending = {i.message: i.id for i in first[-1].outcome.interrupts}
        events = [e async for e in agent.run(make_input("resume", resume=[
            ResumeEntry(interrupt_id=pending["right?"], status="resolved", payload="yes"),
            ResumeEntry(interrupt_id=pending["left?"], status="cancelled"),
        ]))]
        self.assertEqual(events[-1].type, EventType.RUN_FINISHED)
        result = await graph.aget_state({"configurable": {"thread_id": "approval"}})
        self.assertEqual(result.values["right"], "yes")
        self.assertEqual(result.values["left"], {
            "__agui_cancelled__": True, "interrupt_id": pending["left?"],
        })
        self.assertFalse(result.next)
