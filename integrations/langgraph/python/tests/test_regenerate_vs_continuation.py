"""Tests for the ``is_continuation`` discriminator in ``prepare_stream``.

When the client calls the agent after the graph already has a checkpoint
for the thread, ``prepare_stream`` has to decide between two shapes of
"incoming is smaller than checkpoint":

* **Regenerate** — the client is asking to re-run from a user message
  that is already persisted; the incoming list ends with a
  ``HumanMessage`` whose id is in the checkpoint, and the new assistant
  reply must *replace* the previous one rather than be appended. This
  path must dispatch through ``prepare_regenerate_stream``.
* **Continuation** — the client (e.g. CopilotKit) intercepted a tool
  call mid-run and is re-posting the prefix so the server can resume
  execution; the incoming list ends with a non-Human message
  (``AIMessage`` / ``ToolMessage``). Regenerating here would loop.

The original discriminator relied solely on
``incoming_ids.issubset(checkpoint_ids)``. That predicate is also
``True`` for the regenerate case (incoming ``{user_id}`` ⊂ checkpoint
``{user_id, ai_id}``), so regenerate was wrongly classified as
continuation and the new reply was appended after the old one. The
fix adds a "last incoming message must be non-Human" requirement to
the continuation branch.
"""

from __future__ import annotations

import unittest
from typing import List
from unittest.mock import AsyncMock, MagicMock

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

from tests._helpers import make_agent


def _agent_state(messages: List[BaseMessage]) -> MagicMock:
    """Minimal stand-in for the object ``graph.aget_state`` returns.

    ``prepare_stream`` only reads ``.values["messages"]`` and
    ``.tasks``; we expose just those and leave the rest absent so any
    accidental access fails loudly instead of silently passing."""
    state = MagicMock()
    state.values = {"messages": messages}
    state.tasks = []
    return state


def _run_input(messages: List[BaseMessage]) -> MagicMock:
    """Stand-in for ``RunAgentInput``.

    ``prepare_stream`` converts ``input.messages`` (AG-UI wire format)
    into LangChain messages via ``agui_messages_to_langchain``; the
    tests below short-circuit that conversion by patching the helper
    on the agent module so we can supply LangChain messages directly
    and keep the test focused on the continuation-vs-regenerate
    branch."""
    run_input = MagicMock()
    run_input.messages = messages
    run_input.tools = []
    run_input.forwarded_props = {}
    run_input.state = {}
    run_input.thread_id = "thread-xyz"
    return run_input


class _PrepareStreamHarness:
    """Patch the minimal surface of ``LangGraphAgent`` that
    ``prepare_stream`` touches *around* the discriminator so the tests
    below only observe whether ``prepare_regenerate_stream`` is
    invoked.

    We replace:
      * ``agui_messages_to_langchain`` — identity, since we already
        pass LangChain messages in (skips AG-UI parsing).
      * ``langgraph_default_merge_state`` — returns the existing
        checkpoint's ``messages`` unchanged (the real merge is tested
        elsewhere and is not what this test cares about).
      * ``get_schema_keys`` — returns an empty schema (avoids
        exercising the graph's real schema plumbing).
      * ``prepare_regenerate_stream`` — ``AsyncMock`` so we can assert
        call counts and arguments without running the real fork.
      * ``get_stream_kwargs`` / ``graph.astream_events`` — stubbed to
        a trivial async iterator so ``prepare_stream`` can return its
        normal non-regenerate path without hitting a real graph.
    """

    def __init__(self, agent):
        self.agent = agent
        # In-module rebind of the helper so the name ``prepare_stream``
        # resolves against our stub.
        import ag_ui_langgraph.agent as agent_module

        self._agent_module = agent_module
        self._orig_convert = agent_module.agui_messages_to_langchain
        agent_module.agui_messages_to_langchain = lambda msgs: list(msgs)

        agent.langgraph_default_merge_state = (
            lambda state, messages, _input: {
                **state,
                "messages": state.get("messages", []),
            }
        )
        agent.get_schema_keys = MagicMock(
            return_value={"input": [], "output": [], "config": [], "context": []}
        )
        agent.prepare_regenerate_stream = AsyncMock(
            return_value={"stream": None, "state": {}, "config": {}}
        )

        async def _empty_stream(*_args, **_kwargs):
            if False:
                yield

        agent.graph.astream_events = MagicMock(return_value=_empty_stream())
        agent.get_stream_kwargs = MagicMock(return_value={"input": None})

        agent.active_run = {
            "id": "run-1",
            "mode": "start",
            "node_name": None,
            "manually_emitted_state": None,
        }

    def restore(self):
        self._agent_module.agui_messages_to_langchain = self._orig_convert


class TestIsContinuationDiscriminator(unittest.IsolatedAsyncioTestCase):
    async def test_regenerate_dispatches_to_prepare_regenerate_stream(self):
        """Incoming ``[user]`` with checkpoint ``[user, ai]`` must take
        the regenerate branch. The user id is a strict subset of the
        checkpoint ids (which defeats an ``issubset``-only check) and
        the last incoming message is a ``HumanMessage``."""
        user = HumanMessage(content="what can you do?", id="u1")
        ai = AIMessage(content="I can help with...", id="a1")

        agent = make_agent()
        harness = _PrepareStreamHarness(agent)
        try:
            agent_state = _agent_state([user, ai])
            run_input = _run_input([user])
            config = {"configurable": {"thread_id": "thread-xyz"}}

            await agent.prepare_stream(run_input, agent_state, config)

            agent.prepare_regenerate_stream.assert_awaited_once()
            call_kwargs = agent.prepare_regenerate_stream.await_args.kwargs
            self.assertIs(call_kwargs["message_checkpoint"], user)
            self.assertIs(call_kwargs["input"], run_input)
        finally:
            harness.restore()

    async def test_tool_call_continuation_skips_regenerate(self):
        """Tool-call continuation: incoming ``[user, ai_with_tool]``
        with checkpoint ``[user, ai_with_tool, tool_msg]``. Incoming
        ids are a strict subset of checkpoint ids, but the last
        incoming message is an ``AIMessage`` — this is a continuation,
        not a regenerate."""
        user = HumanMessage(content="do a thing", id="u1")
        ai = AIMessage(content="", id="a1", tool_calls=[])
        tool_msg = ToolMessage(content="result", id="t1", tool_call_id="tc1")

        agent = make_agent()
        harness = _PrepareStreamHarness(agent)
        try:
            agent_state = _agent_state([user, ai, tool_msg])
            run_input = _run_input([user, ai])
            config = {"configurable": {"thread_id": "thread-xyz"}}

            await agent.prepare_stream(run_input, agent_state, config)

            agent.prepare_regenerate_stream.assert_not_awaited()
        finally:
            harness.restore()

    async def test_shorter_incoming_ending_in_human_regenerates(self):
        """Deeper fork: incoming ``[u1]`` with checkpoint
        ``[u1, a1, u2, a2]``. Both incoming ids are in the checkpoint
        and the last incoming message is a ``HumanMessage``, so the
        adapter must treat this as a regenerate of ``u1``."""
        u1 = HumanMessage(content="first", id="u1")
        a1 = AIMessage(content="first reply", id="a1")
        u2 = HumanMessage(content="second", id="u2")
        a2 = AIMessage(content="second reply", id="a2")

        agent = make_agent()
        harness = _PrepareStreamHarness(agent)
        try:
            agent_state = _agent_state([u1, a1, u2, a2])
            run_input = _run_input([u1])
            config = {"configurable": {"thread_id": "thread-xyz"}}

            await agent.prepare_stream(run_input, agent_state, config)

            agent.prepare_regenerate_stream.assert_awaited_once()
            self.assertIs(
                agent.prepare_regenerate_stream.await_args.kwargs[
                    "message_checkpoint"
                ],
                u1,
            )
        finally:
            harness.restore()

if __name__ == "__main__":
    unittest.main()
