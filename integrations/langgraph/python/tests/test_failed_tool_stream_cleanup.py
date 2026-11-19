"""A failed tool closes streams opened by models running inside that tool."""

import unittest
from typing import Iterator
from unittest.mock import AsyncMock, MagicMock

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import tool
from langgraph.errors import GraphBubbleUp
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode

from ag_ui.core import EventType

from ag_ui_langgraph.agent import LangGraphAgent
from ag_ui_langgraph.types import LangGraphEventTypes

FAILED_TOOL_RUN_ID = "failed-tool-run"


def _make_agent(*, attributed=False) -> LangGraphAgent:
    agent = LangGraphAgent(
        name="test",
        graph=MagicMock(),
        emit_subagent_events=attributed,
    )
    agent.active_run = {
        "id": "run-1",
        "reasoning_processes": {},
        "pending_reasoning_ids": {},
        "pending_reasoning_parent_ids": {},
        "current_text_message_ids": {},
        "current_text_message_nodes": {},
        "streamed_tool_call_ids": set(),
        "failed_tool_calls": {},
        "node_name": "agent",
        "has_function_streaming": False,
        "model_made_tool_call": False,
        "state_reliable": True,
        "current_subagent_run_id": None,
    }
    agent.dispatched = []
    real_dispatch = agent._dispatch_event

    def _dispatch(event):
        resolved = real_dispatch(event) if attributed else event
        if resolved is not None:
            agent.dispatched.append(resolved)
        return resolved

    agent._dispatch_event = _dispatch
    return agent


def _model_chunk(
    *,
    chunk_id: str,
    content="",
    tool_call_chunks=None,
    parent_ids=None,
    node="tools",
):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "run_id": f"model-{chunk_id}",
        "parent_ids": list(parent_ids or []),
        "metadata": {
            "emit-messages": True,
            "emit-tool-calls": True,
            "langgraph_node": node,
        },
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": content,
                "tool_call_chunks": list(tool_call_chunks or []),
                "response_metadata": {},
            }
        },
    }


def _tool_error(run_id=FAILED_TOOL_RUN_ID):
    return {
        "event": LangGraphEventTypes.OnToolError,
        "run_id": run_id,
        "parent_ids": ["tools-node-run"],
        "name": "ask_helper",
        "data": {"error": RuntimeError("stream cut")},
    }


async def _feed(agent: LangGraphAgent, *events) -> None:
    for event in events:
        async for _ in agent._handle_single_event(event, {}):
            pass


async def _drive_full_stream(events):
    graph = MagicMock()
    graph.config_specs = []
    graph.nodes = {}
    final_state = MagicMock()
    final_state.values = {"messages": []}
    final_state.tasks = []
    final_state.next = []
    final_state.metadata = {"writes": {}}
    graph.aget_state = AsyncMock(return_value=final_state)

    agent = LangGraphAgent(
        name="test",
        graph=graph,
        emit_subagent_events=True,
        emit_raw_events=False,
    )

    async def fake_prepare(*args, **kwargs):
        agent.active_run["schema_keys"] = {
            "input": ["messages"],
            "output": ["messages"],
            "config": [],
            "context": [],
        }

        async def gen():
            for event in events:
                yield event

        return {
            "stream": gen(),
            "state": MagicMock(values={"messages": []}),
            "config": {"configurable": {"thread_id": "t1"}},
        }

    agent.prepare_stream = fake_prepare
    run_input = MagicMock()
    run_input.run_id = "run-1"
    run_input.thread_id = "t1"
    run_input.forwarded_props = {}

    return [
        event
        async for event in agent._handle_stream_events(run_input)
        if event is not None
    ]


def _types(agent: LangGraphAgent):
    return [event.type for event in agent.dispatched]


class _FailingStreamingModel(BaseChatModel):
    """Emit one real model chunk, then fail inside a tool."""

    @property
    def _llm_type(self) -> str:
        return "failing-streaming-model"

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        return ChatResult(
            generations=[ChatGeneration(message=AIMessage(content="unused"))]
        )

    def _stream(
        self, messages, stop=None, run_manager=None, **kwargs
    ) -> Iterator[ChatGenerationChunk]:
        chunk = ChatGenerationChunk(
            message=AIMessageChunk(
                content="partial helper answer",
                id="helper-message",
            )
        )
        if run_manager:
            run_manager.on_llm_new_token(chunk.text, chunk=chunk)
        yield chunk
        raise RuntimeError("stream cut")


async def _real_failed_tool_events():
    model = _FailingStreamingModel()

    @tool
    async def ask_helper(question: str) -> str:
        """Ask a helper model."""
        chunks = []
        async for chunk in model.astream([HumanMessage(content=question)]):
            chunks.append(chunk.text)
        return "".join(chunks)

    graph = StateGraph(MessagesState)
    graph.add_node(
        "tools",
        ToolNode([ask_helper], handle_tool_errors=False),
    )
    graph.add_edge(START, "tools")
    graph.add_edge("tools", END)
    app = graph.compile()

    events = []
    try:
        async for event in app.astream_events(
            {
                "messages": [
                    AIMessage(
                        content="",
                        tool_calls=[
                            {
                                "name": "ask_helper",
                                "args": {"question": "Help"},
                                "id": "helper-call",
                                "type": "tool_call",
                            }
                        ],
                    )
                ]
            },
            version="v2",
        ):
            events.append(event)
    except RuntimeError as exc:
        if str(exc) != "stream cut":
            raise
    else:
        raise AssertionError("the nested model was expected to fail")

    return events


class TestFailedToolStreamCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_real_langgraph_events_preserve_failed_tool_ancestry(self):
        events = await _real_failed_tool_events()
        model_stream = next(
            event
            for event in events
            if event["event"] == LangGraphEventTypes.OnChatModelStream
            and event["data"]["chunk"].content == "partial helper answer"
        )
        tool_error = next(
            event
            for event in events
            if event["event"] == LangGraphEventTypes.OnToolError
            and event["name"] == "ask_helper"
        )

        self.assertIn(tool_error["run_id"], model_stream["parent_ids"])

        agent = _make_agent()
        await _feed(agent, model_stream, tool_error)
        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )

    async def test_closes_text_stream_opened_inside_failed_tool(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-message",
                content="partial helper answer",
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-message",
                content="parent answer",
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        text_events = [
            event
            for event in agent.dispatched
            if event.type
            in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            )
        ]
        self.assertEqual(
            [event.message_id for event in text_events],
            [
                "helper-message",
                "helper-message",
                "helper-message",
                "agent-message",
                "agent-message",
            ],
        )

    async def test_closes_tool_call_stream_opened_inside_failed_tool(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-message",
                tool_call_chunks=[
                    {
                        "id": "helper-call",
                        "name": "read_file",
                        "args": '{"path": "/sh',
                    }
                ],
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-message",
                content="first parent chunk",
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TOOL_CALL_START,
                EventType.TOOL_CALL_END,
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        self.assertEqual(agent.dispatched[1].tool_call_id, "helper-call")
        self.assertEqual(agent.dispatched[-1].delta, "first parent chunk")

    async def test_closes_reasoning_stream_opened_inside_failed_tool(self):
        agent = _make_agent()
        reasoning = [
            {
                "type": "reasoning_content",
                "reasoning_content": {"text": "helper thinks"},
                "index": 0,
            }
        ]

        await _feed(
            agent,
            _model_chunk(
                chunk_id="helper-reasoning",
                content=reasoning,
                parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="agent-reasoning",
                content=[
                    {
                        "type": "reasoning_content",
                        "reasoning_content": {"text": "agent thinks"},
                        "index": 0,
                    }
                ],
                parent_ids=["agent-node-run"],
                node="agent",
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.REASONING_START,
                EventType.REASONING_MESSAGE_START,
                EventType.REASONING_MESSAGE_CONTENT,
                EventType.REASONING_MESSAGE_END,
                EventType.REASONING_END,
                EventType.REASONING_START,
                EventType.REASONING_MESSAGE_START,
                EventType.REASONING_MESSAGE_CONTENT,
            ],
        )
        starts = [
            event.message_id
            for event in agent.dispatched
            if event.type == EventType.REASONING_START
        ]
        self.assertEqual(len(starts), 2)
        self.assertNotEqual(starts[0], starts[1])

    async def test_clears_pending_reasoning_id_from_failed_tool(self):
        agent = _make_agent()
        list(
            agent.handle_reasoning_event(
                {
                    "type": "reasoning_content",
                    "text": "",
                    "id": "rs-failed",
                },
                parent_ids=[FAILED_TOOL_RUN_ID],
            )
        )

        await _feed(agent, _tool_error())
        list(
            agent.handle_reasoning_event(
                {
                    "type": "reasoning_content",
                    "text": "parent thinks",
                },
                parent_ids=["agent-node-run"],
            )
        )

        starts = [
            event
            for event in agent.dispatched
            if event.type == EventType.REASONING_START
        ]
        self.assertEqual(len(starts), 1)
        self.assertNotEqual(starts[0].message_id, "rs-failed")
        self.assertNotIn(
            "__root__", agent.active_run["pending_reasoning_ids"]
        )

    async def test_pending_reasoning_cleanup_is_ancestry_scoped(self):
        agent = _make_agent(attributed=True)

        agent.active_run["current_subagent_run_id"] = "tools:failed"
        list(
            agent.handle_reasoning_event(
                {
                    "type": "reasoning_content",
                    "text": "",
                    "id": "rs-failed",
                },
                parent_ids=[FAILED_TOOL_RUN_ID],
            )
        )
        agent.active_run["current_subagent_run_id"] = "tools:sibling"
        list(
            agent.handle_reasoning_event(
                {
                    "type": "reasoning_content",
                    "text": "",
                    "id": "rs-sibling",
                },
                parent_ids=["other-tool-run"],
            )
        )

        agent.active_run["current_subagent_run_id"] = None
        await _feed(agent, _tool_error())
        pending = agent.active_run["pending_reasoning_ids"]
        self.assertNotIn("tools:failed", pending)
        self.assertEqual(pending["tools:sibling"], "rs-sibling")

        bubble_up = _tool_error("other-tool-run")
        bubble_up["data"]["error"] = GraphBubbleUp()
        await _feed(agent, bubble_up)
        self.assertEqual(pending["tools:sibling"], "rs-sibling")

    async def test_does_not_close_stream_from_unrelated_model(self):
        agent = _make_agent()

        await _feed(
            agent,
            _model_chunk(
                chunk_id="unrelated-message",
                content="before error",
                parent_ids=["other-tool-run"],
            ),
            _tool_error(),
            _model_chunk(
                chunk_id="unrelated-message",
                content=" after error",
                parent_ids=["other-tool-run"],
            ),
        )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_CONTENT,
            ],
        )
        self.assertEqual(
            "".join(
                event.delta
                for event in agent.dispatched
                if event.type == EventType.TEXT_MESSAGE_CONTENT
            ),
            "before error after error",
        )

    async def test_closes_matching_streams_in_their_original_lanes(self):
        agent = _make_agent(attributed=True)

        agent.active_run["current_subagent_run_id"] = "tools:text"
        await _feed(
            agent,
            _model_chunk(
                chunk_id="child-text",
                content="partial",
                parent_ids=[FAILED_TOOL_RUN_ID],
            ),
        )

        agent.active_run["current_subagent_run_id"] = "tools:call"
        await _feed(
            agent,
            _model_chunk(
                chunk_id="child-call",
                tool_call_chunks=[
                    {
                        "id": "child-tool-call",
                        "name": "read_file",
                        "args": '{"path":',
                    }
                ],
                parent_ids=[FAILED_TOOL_RUN_ID],
            ),
        )

        agent.active_run["current_subagent_run_id"] = "tools:reasoning"
        await _feed(
            agent,
            _model_chunk(
                chunk_id="child-reasoning",
                content=[
                    {
                        "type": "reasoning_content",
                        "reasoning_content": {"text": "partial thought"},
                        "index": 0,
                    }
                ],
                parent_ids=[FAILED_TOOL_RUN_ID],
            ),
        )

        agent.active_run["current_subagent_run_id"] = "tools:sibling"
        await _feed(
            agent,
            _model_chunk(
                chunk_id="sibling-text",
                content="still running",
                parent_ids=["other-tool-run"],
            ),
        )

        agent.active_run["current_subagent_run_id"] = None
        await _feed(agent, _tool_error(), _tool_error())

        terminal_owners = [
            (event.type, getattr(event, "subagent_run_id", None))
            for event in agent.dispatched
            if event.type
            in (
                EventType.TEXT_MESSAGE_END,
                EventType.TOOL_CALL_END,
                EventType.REASONING_END,
            )
        ]
        self.assertEqual(
            terminal_owners,
            [
                (EventType.TEXT_MESSAGE_END, "tools:text"),
                (EventType.TOOL_CALL_END, "tools:call"),
                (EventType.REASONING_END, "tools:reasoning"),
            ],
        )
        self.assertIsNotNone(
            agent.get_message_in_progress("run-1", "tools:sibling")
        )
        self.assertIsNone(
            agent.get_message_in_progress("run-1", "tools:text")
        )
        self.assertIsNone(
            agent.get_message_in_progress("run-1", "tools:call")
        )
        self.assertIsNone(agent._get_reasoning_process("tools:reasoning"))

    async def test_task_error_closes_child_before_subagent_terminal(self):
        task_start = {
            "event": LangGraphEventTypes.OnToolStart,
            "run_id": FAILED_TOOL_RUN_ID,
            "name": "task",
            "parent_ids": ["tools-node-run"],
            "metadata": {
                "langgraph_node": "tools",
                "langgraph_checkpoint_ns": "tools:child",
                "lc_agent_name": "researcher",
            },
            "data": {
                "input": {
                    "subagent_type": "researcher",
                    "description": "delegate",
                }
            },
        }
        child_chunk = _model_chunk(
            chunk_id="child-text",
            content="partial child answer",
            parent_ids=["tools-node-run", FAILED_TOOL_RUN_ID],
            node="model",
        )
        child_chunk["metadata"].update(
            {
                "langgraph_checkpoint_ns": "tools:child|model:inner",
                "lc_agent_name": "researcher",
            }
        )
        task_error = _tool_error()
        task_error["name"] = "task"
        task_error["metadata"] = {
            "langgraph_node": "tools",
            "langgraph_checkpoint_ns": "",
            "lc_agent_name": "main",
        }
        parent_chunk = _model_chunk(
            chunk_id="parent-text",
            content="parent recovered",
            parent_ids=["agent-node-run"],
            node="agent",
        )
        parent_chunk["metadata"].update(
            {
                "langgraph_checkpoint_ns": "",
                "lc_agent_name": "main",
            }
        )

        events = await _drive_full_stream(
            [task_start, child_chunk, task_error, parent_chunk]
        )
        relevant = [
            (event.type, getattr(event, "subagent_run_id", None))
            for event in events
            if event.type
            in (
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.SUBAGENT_ERROR,
            )
        ]
        self.assertEqual(
            relevant,
            [
                (EventType.TEXT_MESSAGE_START, "tools:child"),
                (EventType.TEXT_MESSAGE_CONTENT, "tools:child"),
                (EventType.TEXT_MESSAGE_END, "tools:child"),
                (EventType.SUBAGENT_ERROR, "tools:child"),
                (EventType.TEXT_MESSAGE_START, None),
                (EventType.TEXT_MESSAGE_CONTENT, None),
            ],
        )
