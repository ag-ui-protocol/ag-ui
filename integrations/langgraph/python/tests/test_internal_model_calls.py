"""A middleware-internal model call is the middleware's work, not the answer.

Issue #2972: from langchain 1.4.0, middleware such as SummarizationMiddleware
tags its own model calls with ``internal_call_metadata()``, and LangChain keeps
them out of its v3 stream. This adapter drives ``astream_events`` v2, so the
summary reached the client as assistant text in front of the real answer.

The marker is patched in most tests: the locked langchain predates it, and the
behaviour under test is how the adapter treats a tagged event.
"""
import importlib.metadata
import unittest
from unittest.mock import MagicMock, patch

from ag_ui.core import EventType
from ag_ui_langgraph.types import LangGraphEventTypes

KEY = "lc_internal_call"
TOKEN = "token-made-once-per-process"
MARKER = "ag_ui_langgraph.agent._internal_call_marker"
INTERNAL = {"emit-messages": True, "emit-tool-calls": True, KEY: TOKEN}
NORMAL = {"emit-messages": True, "emit-tool-calls": True}


def _fresh_active_run(run_id: str = "run-1") -> dict:
    """Mirror the INITIAL_ACTIVE_RUN shape created by _handle_stream_events."""
    return {
        "id": run_id,
        "thread_id": "t1",
        "mode": "start",
        "reasoning_process": None,
        "node_name": "agent",
        "has_function_streaming": False,
        "streamed_tool_call_ids": set(),
        "model_made_tool_call": False,
        "state_reliable": True,
        "manually_emitted_state": None,
        "schema_keys": {
            "input": ["messages", "tools"],
            "output": ["messages", "tools"],
            "config": [],
            "context": [],
        },
    }


def _make_agent():
    from ag_ui_langgraph.agent import LangGraphAgent

    agent = LangGraphAgent(name="test", graph=MagicMock())
    agent.active_run = _fresh_active_run()
    dispatched = []

    def _dispatch(event):
        dispatched.append(event)
        return event

    agent._dispatch_event = _dispatch
    agent.dispatched = dispatched
    return agent


def _text_chunk(chunk_id, content, metadata):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": dict(metadata),
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": content,
                "tool_call_chunks": [],
                "response_metadata": {},
            }
        },
    }


def _tool_call_chunk(chunk_id, tool_call, metadata):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": dict(metadata),
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": "",
                "tool_call_chunks": [tool_call],
                "response_metadata": {},
            }
        },
    }


def _reasoning_chunk(chunk_id, reasoning, metadata):
    return {
        "event": LangGraphEventTypes.OnChatModelStream,
        "metadata": dict(metadata),
        "data": {
            "chunk": {
                "id": chunk_id,
                "content": [{"type": "reasoning", "reasoning": reasoning, "index": 0}],
                "tool_call_chunks": [],
                "response_metadata": {},
            }
        },
    }


def _model_end(metadata):
    return {
        "event": LangGraphEventTypes.OnChatModelEnd,
        "metadata": dict(metadata),
        "data": {},
    }


async def _feed(agent, *events):
    for event in events:
        async for _ in agent._handle_single_event(event, {}):
            pass


def _types(agent):
    return [event.type for event in agent.dispatched]


def _text(agent):
    return "".join(
        event.delta
        for event in agent.dispatched
        if event.type == EventType.TEXT_MESSAGE_CONTENT
    )


class TestInternalModelCalls(unittest.IsolatedAsyncioTestCase):
    async def test_an_internal_text_call_reaches_the_client_as_nothing(self):
        agent = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            await _feed(
                agent,
                _text_chunk("summary", "Here is a summary of the conversation", INTERNAL),
                _model_end(INTERNAL),
            )

        self.assertEqual(agent.dispatched, [])

    async def test_an_internal_tool_call_reaches_the_client_as_nothing(self):
        """LLMToolSelectorMiddleware calls the model through with_structured_output,
        so its internal call can stream tool-call chunks rather than text."""
        agent = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            await _feed(
                agent,
                _tool_call_chunk(
                    "select",
                    {"id": "sel-1", "name": "ToolSelectionResponse", "args": ""},
                    INTERNAL,
                ),
                _tool_call_chunk("select", {"args": '{"tools": ["search"]}'}, INTERNAL),
                _model_end(INTERNAL),
            )

        self.assertEqual(agent.dispatched, [])

    async def test_an_internal_call_from_a_reasoning_model_shows_no_reasoning(self):
        """Reasoning is not gated by emit-messages, so hiding an internal call
        through that flag would still stream its reasoning to the client."""
        shown = _make_agent()
        hidden = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            # Control: the same chunk from a normal call does produce reasoning,
            # so the empty result below is not an artefact of the chunk shape.
            await _feed(shown, _reasoning_chunk("answer", "weighing the options", NORMAL))
            await _feed(
                hidden,
                _reasoning_chunk("summary", "weighing the options", INTERNAL),
                _model_end(INTERNAL),
            )

        self.assertIn(EventType.REASONING_START, _types(shown))
        self.assertEqual(hidden.dispatched, [])

    async def test_the_answer_after_an_internal_call_streams_as_before(self):
        """The case from the issue: a summary first, then the real answer."""
        agent = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            await _feed(
                agent,
                _text_chunk("summary", "SUMMARY-TEXT the user asked why sign-ins fail.", INTERNAL),
                _model_end(INTERNAL),
                _text_chunk("answer", "ANSWER-TEXT the certificate has expired.", NORMAL),
                _model_end(NORMAL),
            )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(_text(agent), "ANSWER-TEXT the certificate has expired.")

    async def test_an_internal_call_leaves_a_message_in_progress_alone(self):
        """An internal tool-call chunk and its model end arrive while the real
        answer is still streaming. Neither may close that answer: with the
        answer's id still open, its next delta continues the same message."""
        agent = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            await _feed(
                agent,
                _text_chunk("answer", "Let me", NORMAL),
                _tool_call_chunk(
                    "select",
                    {"id": "sel-1", "name": "ToolSelectionResponse", "args": ""},
                    INTERNAL,
                ),
                _model_end(INTERNAL),
                _text_chunk("answer", " check.", NORMAL),
                _model_end(NORMAL),
            )

        self.assertEqual(
            _types(agent),
            [
                EventType.TEXT_MESSAGE_START,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
            ],
        )
        self.assertEqual(_text(agent), "Let me check.")
        self.assertEqual(len({event.message_id for event in agent.dispatched}), 1)

    async def test_the_key_with_another_value_does_not_hide_a_call(self):
        """The value is a token made once per process. Metadata a caller sets
        with the same key but its own value must not hide a real model call."""
        agent = _make_agent()

        with patch(MARKER, return_value=(KEY, TOKEN)):
            await _feed(
                agent,
                _text_chunk("answer", "real answer", {**NORMAL, KEY: "set-by-a-caller"}),
                _model_end({**NORMAL, KEY: "set-by-a-caller"}),
            )

        self.assertEqual(_text(agent), "real answer")

    async def test_langchain_without_the_marker_hides_nothing(self):
        """Before langchain 1.4.0 no call is tagged, so nothing is filtered."""
        agent = _make_agent()

        with patch(MARKER, return_value=None):
            await _feed(
                agent,
                _text_chunk("answer", "real answer", INTERNAL),
                _model_end(INTERNAL),
            )

        self.assertEqual(_text(agent), "real answer")


def _langchain_has_the_marker() -> bool:
    try:
        from langchain.agents.middleware import internal_call_transformer  # noqa: F401
    except ImportError:
        return False
    return True


@unittest.skipUnless(
    _langchain_has_the_marker(),
    f"langchain {importlib.metadata.version('langchain')} predates internal_call_metadata (1.4.0)",
)
class TestTheMarkerIsLangChains(unittest.TestCase):
    def test_the_marker_is_the_one_langchains_middleware_sets(self):
        from langchain.agents.middleware.internal_call_transformer import (
            internal_call_metadata,
        )
        from ag_ui_langgraph.agent import _internal_call_marker

        _internal_call_marker.cache_clear()
        self.assertEqual(dict([_internal_call_marker()]), internal_call_metadata())


@unittest.skipUnless(
    _langchain_has_the_marker(),
    f"langchain {importlib.metadata.version('langchain')} predates internal_call_metadata (1.4.0)",
)
class TestSummarizationMiddlewareEndToEnd(unittest.IsolatedAsyncioTestCase):
    """The reported case, through a real agent: the summary stays out of the
    client's text and the answer streams as before."""

    SUMMARY = "SUMMARY-TEXT the user asked why sign-ins fail."
    ANSWER = "ANSWER-TEXT the certificate has expired."

    def make_agent(self):
        from langchain.agents import create_agent
        from langchain.agents.middleware import SummarizationMiddleware
        from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
        from langchain_core.messages import AIMessage
        from langgraph.checkpoint.memory import MemorySaver

        from ag_ui_langgraph.agent import LangGraphAgent

        graph = create_agent(
            model=GenericFakeChatModel(messages=iter([AIMessage(content=self.ANSWER)])),
            tools=[],
            middleware=[
                SummarizationMiddleware(
                    model=GenericFakeChatModel(
                        messages=iter([AIMessage(content=self.SUMMARY)])
                    ),
                    # Three messages arrive, so the summary runs before the answer.
                    trigger=("messages", 3),
                    keep=("messages", 1),
                )
            ],
            checkpointer=MemorySaver(),
        )
        return LangGraphAgent(name="summarizing", graph=graph)

    def run_input(self):
        from ag_ui.core import AssistantMessage, RunAgentInput, UserMessage

        return RunAgentInput(
            thread_id="thread-2972",
            run_id="run-2972",
            state={},
            tools=[],
            context=[],
            forwarded_props={},
            messages=[
                UserMessage(id="u1", role="user", content="Why do sign-ins fail?"),
                AssistantMessage(id="a1", role="assistant", content="Let me check."),
                UserMessage(id="u2", role="user", content="Any idea yet?"),
            ],
        )

    async def client_text(self, agent):
        events = [event async for event in agent.run(self.run_input())]
        return "".join(
            event.delta for event in events if event.type == EventType.TEXT_MESSAGE_CONTENT
        )

    async def test_the_summary_stays_out_of_the_client_text(self):
        # Control: with the check off, this setup does stream the summary, so
        # the clean result below is the check working, not a summary that never ran.
        with patch("ag_ui_langgraph.agent._is_internal_model_call", return_value=False):
            unfiltered = await self.client_text(self.make_agent())
        self.assertIn(self.SUMMARY, unfiltered)

        self.assertEqual(await self.client_text(self.make_agent()), self.ANSWER)


if __name__ == "__main__":
    unittest.main()
