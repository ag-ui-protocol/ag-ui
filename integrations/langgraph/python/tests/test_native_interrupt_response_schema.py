"""LangGraph's native ``Interrupt.response_schema`` must reach the AG-UI interrupt.

``interrupt(value, response_schema=Model)`` (langgraph >= 1.2.12) validates the
resume value and puts the model's JSON Schema on ``Interrupt.response_schema``,
next to ``value``. The adapter used to read the schema only from inside the
value, so ``RUN_FINISHED.outcome.interrupts[].responseSchema`` was always empty
for graphs using the native feature (ag-ui-protocol/ag-ui#3040).

These tests run a real, minimal, fully offline graph (one node that interrupts,
``MemorySaver``) through the adapter.
"""
import inspect
import json
import unittest
from typing import List, Optional

from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.types import interrupt
from pydantic import BaseModel, TypeAdapter
from typing_extensions import TypedDict

from ag_ui.core import EventType, ResumeEntry, RunAgentInput, UserMessage
from ag_ui.encoder import EventEncoder
from ag_ui_langgraph import LangGraphAgent

NATIVE_RESPONSE_SCHEMA = "response_schema" in inspect.signature(interrupt).parameters


class Decision(BaseModel):
    approved: bool


class DecisionDict(TypedDict):
    approved: bool


class ApprovalState(MessagesState):
    approved: Optional[bool]


def _build_agent(response_schema, value=None) -> LangGraphAgent:
    def ask(state: ApprovalState):
        answer = interrupt(value if value is not None else {"question": "approve?"},
                           response_schema=response_schema)
        approved = answer.approved if isinstance(answer, BaseModel) else answer["approved"]
        return {"approved": approved}

    graph = StateGraph(ApprovalState)
    graph.add_node("ask", ask)
    graph.add_edge(START, "ask")
    return LangGraphAgent(name="native-response-schema",
                          graph=graph.compile(checkpointer=MemorySaver()),
                          emit_interrupt_outcome=True)


def _input(run_id: str, resume: Optional[List[ResumeEntry]] = None) -> RunAgentInput:
    return RunAgentInput(
        thread_id="thread-1", run_id=run_id, state={},
        messages=[UserMessage(id="user-1", role="user", content="Ship it?")],
        tools=[], context=[], forwarded_props={}, resume=resume,
    )


async def _run(agent: LangGraphAgent, run_input: RunAgentInput) -> list:
    return [e async for e in agent.run(run_input) if not isinstance(e, str)]


def _finished(events: list):
    finished = [e for e in events if e.type == EventType.RUN_FINISHED]
    assert len(finished) == 1, [e.type for e in events]
    return finished[0]


@unittest.skipUnless(NATIVE_RESPONSE_SCHEMA,
                     "interrupt(response_schema=...) needs langgraph >= 1.2.12")
class TestNativeInterruptResponseSchema(unittest.IsolatedAsyncioTestCase):

    async def test_pydantic_model_schema_reaches_the_outcome(self):
        events = await _run(_build_agent(Decision), _input("run-1"))

        outcome = _finished(events).outcome
        self.assertEqual(outcome.type, "interrupt")
        self.assertEqual(len(outcome.interrupts), 1)
        surfaced = outcome.interrupts[0]
        self.assertEqual(surfaced.response_schema, TypeAdapter(Decision).json_schema())
        self.assertEqual(surfaced.reason, "langgraph:interrupt")
        # The value is carried unchanged; the schema is not folded into it.
        self.assertEqual(surfaced.metadata["langgraph"]["raw"], {"question": "approve?"})

    async def test_wire_event_carries_camel_case_response_schema(self):
        events = await _run(_build_agent(Decision), _input("run-1"))

        encoded = EventEncoder().encode(_finished(events))
        self.assertTrue(encoded.startswith("data: "))
        payload = json.loads(encoded[len("data: "):])
        self.assertEqual(payload["outcome"]["interrupts"][0]["responseSchema"],
                         TypeAdapter(Decision).json_schema())

    async def test_typed_dict_and_raw_json_schema_are_surfaced(self):
        raw_schema = {"type": "object", "properties": {"approved": {"type": "boolean"}},
                      "required": ["approved"]}
        for schema, expected in ((DecisionDict, TypeAdapter(DecisionDict).json_schema()),
                                 (raw_schema, raw_schema)):
            with self.subTest(schema=schema):
                events = await _run(_build_agent(schema), _input("run-1"))
                self.assertEqual(_finished(events).outcome.interrupts[0].response_schema,
                                 expected)

    async def test_string_value_keeps_message_and_schema(self):
        events = await _run(_build_agent(Decision, value="approve?"), _input("run-1"))

        surfaced = _finished(events).outcome.interrupts[0]
        self.assertEqual(surfaced.message, "approve?")
        self.assertEqual(surfaced.response_schema, TypeAdapter(Decision).json_schema())

    async def test_interrupt_without_schema_has_none(self):
        events = await _run(_build_agent(None), _input("run-1"))

        surfaced = _finished(events).outcome.interrupts[0]
        self.assertIsNone(surfaced.response_schema)
        encoded = EventEncoder().encode(_finished(events))
        self.assertNotIn("responseSchema", encoded)

    async def test_resume_answers_the_schema_carrying_interrupt(self):
        agent = _build_agent(Decision)
        first = await _run(agent, _input("run-1"))
        interrupt_id = _finished(first).outcome.interrupts[0].id

        second = await _run(agent, _input("run-2", resume=[
            ResumeEntry(interrupt_id=interrupt_id, status="resolved",
                        payload={"approved": True}),
        ]))

        self.assertIsNone(getattr(_finished(second), "outcome", None))
        state = await agent.graph.aget_state({"configurable": {"thread_id": "thread-1"}})
        self.assertIs(state.values["approved"], True)
        self.assertEqual(state.tasks, ())


if __name__ == "__main__":
    unittest.main()
