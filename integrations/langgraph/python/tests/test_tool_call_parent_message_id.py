"""
Which message a non-streamed tool call is attached to.

A tool call that never streamed through ``OnChatModelStream`` — a model that
does not stream, or a call the previous run streamed before an interrupt — is
announced from ``OnToolEnd`` instead. That announcement used to name the tool
*result's* id as the call's parent, and then reuse the same id for the result
message itself. A client therefore received an assistant message and a tool
message sharing one id: the call was hung on a stand-in that no snapshot would
ever recognise, and any consumer that merges messages by id (CopilotKit does)
let the tool message overwrite the assistant message that carried the call.

The parent of a tool call is the assistant message whose ``tool_calls`` hold
it. These tests pin that contract on the ``OnToolEnd`` path.
"""

import asyncio
import unittest

from langchain_core.messages import AIMessage, AIMessageChunk, ToolMessage

from ag_ui.core import EventType
from ag_ui_langgraph.agent import LangGraphAgent
from tests.test_nested_tool_end_dedup import _event, _make_agent, _run_stream, _tool_end


def _model_end(output):
    return _event("on_chat_model_end", node="model", data={"output": output})


def _ai_message_with_call(*, message_id, tool_call_id, name="search"):
    return AIMessage(
        content="",
        id=message_id,
        tool_calls=[{"id": tool_call_id, "name": name, "args": {"query": "x"}}],
    )


def _first(dispatched, event_type, tool_call_id):
    return next(
        ev
        for ev in dispatched
        if ev.type == event_type and getattr(ev, "tool_call_id", None) == tool_call_id
    )


class TestNonStreamedToolCallParent(unittest.TestCase):
    def test_parent_is_the_assistant_message_that_made_the_call(self):
        dispatched = asyncio.run(
            _run_stream(
                [
                    # A model that did not stream: its message arrives whole.
                    _model_end(_ai_message_with_call(message_id="ai-1", tool_call_id="tc-1")),
                    _tool_end("search", "tc-1", content="found"),
                ]
            )
        )

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-1")
        self.assertEqual(start.parent_message_id, "ai-1")

    def test_result_id_never_doubles_as_the_parent(self):
        dispatched = asyncio.run(
            _run_stream(
                [
                    _model_end(_ai_message_with_call(message_id="ai-1", tool_call_id="tc-1")),
                    _tool_end("search", "tc-1", content="found"),
                ]
            )
        )

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-1")
        result = _first(dispatched, EventType.TOOL_CALL_RESULT, "tc-1")
        self.assertNotEqual(start.parent_message_id, result.message_id)

    def test_each_parallel_call_keeps_its_own_owner(self):
        dispatched = asyncio.run(
            _run_stream(
                [
                    _model_end(_ai_message_with_call(message_id="ai-1", tool_call_id="tc-1")),
                    _model_end(_ai_message_with_call(message_id="ai-2", tool_call_id="tc-2")),
                    _tool_end("search", "tc-2", content="second"),
                    _tool_end("search", "tc-1", content="first"),
                ]
            )
        )

        self.assertEqual(_first(dispatched, EventType.TOOL_CALL_START, "tc-1").parent_message_id, "ai-1")
        self.assertEqual(_first(dispatched, EventType.TOOL_CALL_START, "tc-2").parent_message_id, "ai-2")

    def test_owner_unknown_sends_no_parent_rather_than_a_wrong_one(self):
        # The call streamed in the run before an interrupt, so this run never
        # saw the model message that made it. Naming no parent lets the client
        # find the call where it already is; naming the result id did not.
        dispatched = asyncio.run(_run_stream([_tool_end("search", "tc-1", content="found")]))

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-1")
        self.assertIsNone(start.parent_message_id)

    def test_last_model_message_to_carry_a_call_owns_it(self):
        # One call id from two model calls in a run (a retried model call):
        # the later message is the owner.
        dispatched = asyncio.run(
            _run_stream(
                [
                    _model_end(_ai_message_with_call(message_id="ai-1", tool_call_id="tc-1")),
                    _model_end(_ai_message_with_call(message_id="ai-2", tool_call_id="tc-1")),
                    _tool_end("search", "tc-1", content="found"),
                ]
            )
        )

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-1")
        self.assertEqual(start.parent_message_id, "ai-2")

    def test_streamed_calls_keep_the_chunk_id_as_parent(self):
        # Regression guard: the streaming path already names the right parent,
        # and recording owners at model end must not disturb it. A streamed
        # START goes out before OnChatModelEnd records any owner, so the owner
        # map cannot reach it; what can go wrong is OnToolEnd announcing the
        # call a second time. The model-end message carries its own id so the
        # one START is pinned to the chunk id, not to whichever id was recorded.
        chunk = AIMessageChunk(content="", id="ai-stream-1")
        chunk.response_metadata = {}
        chunk.tool_call_chunks = [{"name": "search", "args": "", "id": "tc-1", "index": 0}]
        end_chunk = AIMessageChunk(content="", id="ai-stream-1")
        end_chunk.response_metadata = {}
        end_chunk.tool_call_chunks = []

        dispatched = asyncio.run(
            _run_stream(
                [
                    _event("on_chat_model_stream", data={"chunk": chunk}),
                    _event("on_chat_model_stream", data={"chunk": end_chunk}),
                    _model_end(_ai_message_with_call(message_id="ai-end", tool_call_id="tc-1")),
                    _tool_end("search", "tc-1", content="found"),
                ]
            )
        )

        starts = [
            ev
            for ev in dispatched
            if ev.type == EventType.TOOL_CALL_START and ev.tool_call_id == "tc-1"
        ]
        self.assertEqual(len(starts), 1)
        self.assertEqual(starts[0].parent_message_id, "ai-stream-1")


def _ns_event(event_type, *, ns, agent_name, run_id, name=None, data=None):
    """An event whose lane comes from its namespace, as in a deepagents run."""
    return {
        "event": event_type,
        "run_id": run_id,
        "metadata": {
            "langgraph_node": ns.split("|")[-1].split(":")[0],
            "langgraph_checkpoint_ns": ns,
            "lc_agent_name": agent_name,
        },
        "data": data or {},
        "name": name or "model",
        "parent_ids": [],
        "tags": [],
    }


def _ns_tool_end(*, ns, agent_name, run_id, name, tool_call_id):
    return _ns_event(
        "on_tool_end",
        ns=ns,
        agent_name=agent_name,
        run_id=run_id,
        name=name,
        data={
            "output": ToolMessage(content="ok", tool_call_id=tool_call_id, name=name),
            "input": {},
        },
    )


class TestNonStreamedToolCallParentAcrossSubagentLanes(unittest.TestCase):
    """With subagent events on, owners are stored and read per lane. The lane
    at OnChatModelEnd must match the lane at OnToolEnd, or the lookup misses
    and the call loses its parent. Lanes here come from each event's
    checkpoint namespace through the real reconcile_subagents, not set by hand.
    """

    def _run_deepagents_delegation(self):
        agent = _make_agent()
        flagged = LangGraphAgent(
            name="test", graph=agent.graph, emit_subagent_events=True
        )
        events = [
            # The supervisor (root lane) asks for a `task` delegation.
            _ns_event(
                "on_chat_model_end",
                ns="model:s1",
                agent_name="supervisor",
                run_id="run-sup-model",
                data={"output": _ai_message_with_call(
                    message_id="ai-sup", tool_call_id="tc-task", name="task",
                )},
            ),
            _ns_event(
                "on_tool_start",
                ns="tools:sub1",
                agent_name="supervisor",
                run_id="run-task",
                name="task",
                data={"input": {"subagent_type": "researcher", "description": "dig"}},
            ),
            # The subagent's own model makes a call; its namespace opens the lane.
            _ns_event(
                "on_chat_model_end",
                ns="tools:sub1|model:m1",
                agent_name="researcher",
                run_id="run-sub-model",
                data={"output": _ai_message_with_call(
                    message_id="ai-sub", tool_call_id="tc-grep", name="grep",
                )},
            ),
            # The subagent's inner tool runs in the subagent's lane.
            _ns_tool_end(
                ns="tools:sub1|tools:t1",
                agent_name="researcher",
                run_id="run-grep",
                name="grep",
                tool_call_id="tc-grep",
            ),
            # The `task` call returns in the supervisor's lane.
            _ns_tool_end(
                ns="tools:sub1",
                agent_name="supervisor",
                run_id="run-task",
                name="task",
                tool_call_id="tc-task",
            ),
        ]
        return asyncio.run(_run_stream(events, agent=flagged))

    def test_subagent_inner_call_is_owned_by_the_subagent_message(self):
        dispatched = self._run_deepagents_delegation()

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-grep")
        self.assertEqual(start.subagent_run_id, "tools:sub1")
        self.assertEqual(start.parent_message_id, "ai-sub")

    def test_task_call_is_owned_by_the_supervisor_message(self):
        dispatched = self._run_deepagents_delegation()

        start = _first(dispatched, EventType.TOOL_CALL_START, "tc-task")
        self.assertIsNone(start.subagent_run_id)
        self.assertEqual(start.parent_message_id, "ai-sup")


if __name__ == "__main__":
    unittest.main()
