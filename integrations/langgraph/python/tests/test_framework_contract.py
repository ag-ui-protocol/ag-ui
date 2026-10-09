"""Exercise the supported LangGraph API with real graphs, without an LLM."""

import unittest
from typing_extensions import TypedDict

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import Command, interrupt

from ag_ui_langgraph.agent import LangGraphAgent


class State(TypedDict, total=False):
    tenant: str
    approved: bool


class Context(TypedDict):
    tenant: str


class FrameworkContractTest(unittest.IsolatedAsyncioTestCase):
    async def test_stream_forwards_context_with_explicit_values_winning(self):
        async def read_context(state: State, runtime: Runtime[Context]):
            return {"tenant": runtime.context["tenant"]}

        builder = StateGraph(State, context_schema=Context)
        builder.add_node("read_context", read_context)
        builder.add_edge(START, "read_context")
        builder.add_edge("read_context", END)
        graph = builder.compile()
        agent = LangGraphAgent(name="context", graph=graph)
        config = {"configurable": {"tenant": "configured"}}
        kwargs = agent.get_stream_kwargs(
            input={}, config=config, context={"tenant": "explicit"},
        )
        events = [event async for event in graph.astream_events(**kwargs)]
        self.assertEqual(events[-1]["data"]["output"], {"tenant": "explicit"})
        self.assertEqual(config, {"configurable": {"tenant": "configured"}})

    async def test_context_and_false_decision_survive_checkpoint_resume(self):
        async def approve(state: State, runtime: Runtime[Context]):
            approved = interrupt({"question": "Approve?"})
            return {"approved": approved, "tenant": runtime.context["tenant"]}

        builder = StateGraph(State, context_schema=Context)
        builder.add_node("approve", approve)
        builder.add_edge(START, "approve")
        builder.add_edge("approve", END)
        graph = builder.compile(checkpointer=InMemorySaver())
        agent = LangGraphAgent(name="checkpoint", graph=graph)
        config = {"configurable": {"thread_id": "framework-contract"}}

        async def stream(value, tenant):
            kwargs = agent.get_stream_kwargs(
                input=value, config=config, context={"tenant": tenant},
            )
            return [event async for event in graph.astream_events(**kwargs)]

        await stream({}, "before")
        suspended = await graph.aget_state(config)
        self.assertTrue(suspended.tasks[0].interrupts)
        await stream(Command(resume=False), "after")
        resumed = await graph.aget_state(config)
        self.assertEqual(resumed.values, {"approved": False, "tenant": "after"})
        self.assertFalse(resumed.next)
