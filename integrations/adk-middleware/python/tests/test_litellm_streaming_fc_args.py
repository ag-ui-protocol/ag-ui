"""Streamed function-call arguments for non-Gemini models (LiteLLM), end to end.

google-adk >= 2.10 streams function-call arguments for LiteLLM / OpenAI /
Anthropic / Apigee adapters (google/adk-python f449780): each argument fragment
is surfaced as a partial ``FunctionCall`` (``partial_args`` + ``will_continue``).

These tests drive ADK's *real* LiteLLM streaming code and a *real* ``Runner`` in
``StreamingMode.SSE`` — only the network call (``LiteLLMClient.acompletion``) is
faked, replaying provider-style tool-call fragments.

Layer 1 (``test_adk_runner_*``)  proves ADK itself emits the fragments.
Layer 2 (``test_agui_*``)        asserts the AG-UI event stream produced by
                                 ``ADKAgent`` forwards them incrementally.
"""

from __future__ import annotations

import json
import uuid
import warnings
from typing import Any, AsyncIterator, List

import pytest

litellm = pytest.importorskip("litellm")
adk_lite_llm = pytest.importorskip("google.adk.models.lite_llm")
_adk_streaming_utils = pytest.importorskip("google.adk.utils.streaming_utils")
if not hasattr(_adk_streaming_utils, "_JsonPathTracker"):
    pytest.skip(
        "google-adk < 2.10 does not stream function-call args for LiteLLM",
        allow_module_level=True,
    )

from ag_ui.core import (
    EventType,
    RunAgentInput,
)
from ag_ui.core import Tool as AGUITool  # noqa: E402
from ag_ui.core import (
    UserMessage,
)
from google.adk.agents import LlmAgent  # noqa: E402
from google.adk.agents.run_config import RunConfig, StreamingMode  # noqa: E402
from google.adk.runners import InMemoryRunner  # noqa: E402
from google.genai import types  # noqa: E402
from litellm.types.utils import (  # noqa: E402
    ChatCompletionDeltaToolCall,
    Delta,
    Function,
    ModelResponseStream,
    StreamingChoices,
)

from ag_ui_adk import ADKAgent, AGUIToolset  # noqa: E402

TOOL_NAME = "write_document"

# Final arguments the "model" produces. Mixed value types + nesting on purpose:
# a robust extractor must not assume flat, string-only arguments.
EXPECTED_ARGS = {
    "title": 'Onboarding "Guide"',
    "content": "Line one.\nLine two with unicode é and a backslash \\ .",
    "priority": 3,
    "published": True,
    "tags": ["backend", "onboarding"],
    "meta": {"author": "bot", "revision": 2},
}

TOOL_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "content": {"type": "string"},
        "priority": {"type": "integer"},
        "published": {"type": "boolean"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "meta": {
            "type": "object",
            "properties": {
                "author": {"type": "string"},
                "revision": {"type": "integer"},
            },
        },
    },
    "required": ["title", "content"],
}


def _arguments(index: int = 0) -> dict:
    if index == 0:
        return EXPECTED_ARGS
    return {
        **EXPECTED_ARGS,
        "title": f"Parallel document {index}",
        "content": f"Independent payload {index}: " + EXPECTED_ARGS["content"],
    }


def _fragments(size: int = 7, index: int = 0) -> List[str]:
    """Split the final args JSON into small provider-style fragments."""
    raw = json.dumps(_arguments(index))
    return [raw[i : i + size] for i in range(0, len(raw), size)]


def _chunk(
    *, tool: dict | None = None, finish: str | None = None, index: int = 0
) -> ModelResponseStream:
    tool_calls = None
    if tool is not None:
        tool_calls = [
            ChatCompletionDeltaToolCall(
                id=tool.get("id"),
                type="function",
                index=index,
                function=Function(
                    name=tool.get("name"), arguments=tool.get("args", "")
                ),
            )
        ]
    return ModelResponseStream(
        choices=[
            StreamingChoices(
                index=0,
                finish_reason=finish,
                delta=Delta(content=None, tool_calls=tool_calls),
            )
        ]
    )


class FakeLiteLLMClient(adk_lite_llm.LiteLLMClient):
    """Replays provider-style streamed tool calls: name first, then arg fragments.

    With ``parallel_calls > 1`` every call is opened first and the argument
    fragments are then interleaved round-robin (as OpenAI does for parallel
    tool calls), each chunk tagged with its tool-call ``index``.
    """

    def __init__(self, parallel_calls: int = 1) -> None:
        super().__init__()
        self.calls = 0
        self.parallel_calls = parallel_calls

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any):  # type: ignore[override]
        self.calls += 1
        assert kwargs.get("stream"), "ADK must request a streaming completion"

        already_called = any(
            (m.get("role") if isinstance(m, dict) else None) == "tool" for m in messages
        )

        async def _stream() -> AsyncIterator[ModelResponseStream]:
            if (
                already_called
            ):  # tool result is in history: finish with text, don't loop
                yield ModelResponseStream(
                    choices=[
                        StreamingChoices(
                            index=0, finish_reason="stop", delta=Delta(content="Done.")
                        )
                    ]
                )
                return
            n = self.parallel_calls
            for i in range(n):
                yield _chunk(
                    tool={"id": f"call_{i}", "name": TOOL_NAME, "args": ""}, index=i
                )
            frags = [_fragments(index=i) for i in range(n)]
            for position in range(max(map(len, frags))):
                for i in range(n):
                    if position < len(frags[i]):
                        yield _chunk(tool={"args": frags[i][position]}, index=i)
            yield _chunk(finish="tool_calls")

        return _stream()


def _agent(tools: list, parallel_calls: int = 1) -> LlmAgent:
    return LlmAgent(
        name="writer",
        model=adk_lite_llm.LiteLlm(
            model="openai/fake-model", llm_client=FakeLiteLLMClient(parallel_calls)
        ),
        instruction="Always call write_document.",
        tools=tools,
    )


def write_document(title: str, content: str) -> dict:
    """Write a document.

    Args:
        title: Title.
        content: Body.
    """
    return {"ok": True}


# --------------------------------------------------------------------------- #
# Layer 1 — raw ADK Runner (SSE)
# --------------------------------------------------------------------------- #
async def test_adk_runner_emits_partial_function_call_args():
    """Sanity: ADK's own Runner streams each argument fragment as a partial FunctionCall."""
    runner = InMemoryRunner(agent=_agent([write_document]), app_name="t")
    session = await runner.session_service.create_session(app_name="t", user_id="u")

    partials, finals = [], []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        async for ev in runner.run_async(
            user_id="u",
            session_id=session.id,
            new_message=types.Content(role="user", parts=[types.Part(text="write it")]),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        ):
            for fc in ev.get_function_calls() or []:
                (partials if ev.partial else finals).append(fc)

    incremental = [fc for fc in partials if fc.partial_args or fc.will_continue]
    assert (
        len(incremental) > 1
    ), f"ADK produced {len(incremental)} incremental partial FC events"
    assert any(fc.partial_args for fc in incremental), "no PartialArg payloads surfaced"
    assert finals and finals[-1].args == EXPECTED_ARGS


# --------------------------------------------------------------------------- #
# Layer 2 — ADKAgent -> AG-UI events (ADKAgent builds its own SSE Runner)
# --------------------------------------------------------------------------- #
async def _run_agui(
    streaming_flag: bool, resumable: bool = False, parallel_calls: int = 1
):
    client_tool = AGUITool(
        name=TOOL_NAME, description="Write a document.", parameters=TOOL_SCHEMA
    )
    llm_agent = _agent([AGUIToolset()], parallel_calls)
    if resumable:
        from google.adk.apps import App, ResumabilityConfig

        agent = ADKAgent.from_app(
            App(
                name="litellm_stream_test",
                root_agent=llm_agent,
                resumability_config=ResumabilityConfig(is_resumable=True),
            ),
            user_id="u",
            use_in_memory_services=True,
            streaming_function_call_arguments=streaming_flag,
        )
    else:
        agent = ADKAgent(
            adk_agent=llm_agent,
            app_name="litellm_stream_test",
            user_id="u",
            use_in_memory_services=True,
            streaming_function_call_arguments=streaming_flag,
        )
    inp = RunAgentInput(
        thread_id=f"t-{uuid.uuid4().hex[:8]}",
        run_id=f"r-{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="u1", role="user", content="write it")],
        tools=[client_tool],
        context=[],
        state={},
        forwarded_props={},
    )
    events = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        async for ev in agent.run(inp):
            events.append(ev)
    return events


@pytest.fixture(autouse=True)
def _reset_session_manager():
    from ag_ui_adk.session_manager import SessionManager

    SessionManager.reset_instance()
    yield
    SessionManager.reset_instance()


# The flag=False case is the target behaviour: streamed args must not depend on
# the Gemini/Vertex-specific opt-in, they should follow from ADK's partial events.
@pytest.mark.parametrize(
    "resumable", [False, True], ids=["fire_and_forget", "resumable"]
)
@pytest.mark.parametrize("streaming_flag", [True, False], ids=["flag_on", "flag_off"])
async def test_agui_streams_tool_call_args_incrementally(
    streaming_flag: bool, resumable: bool
):
    events = await _run_agui(streaming_flag, resumable)
    types_seen = [str(e.type).split(".")[-1] for e in events]

    errors = [e for e in events if e.type == EventType.RUN_ERROR]
    assert not errors, f"run errored: {errors[0].message}"

    starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
    assert (
        len(starts) == 1
    ), f"expected exactly one TOOL_CALL_START, got {len(starts)}: {types_seen}"
    call_id = starts[0].tool_call_id
    assert starts[0].tool_call_name == TOOL_NAME

    args = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_ARGS and e.tool_call_id == call_id
    ]
    ends = [
        e
        for e in events
        if e.type == EventType.TOOL_CALL_END and e.tool_call_id == call_id
    ]
    assert len(ends) == 1, f"expected exactly one TOOL_CALL_END, got {len(ends)}"

    # 1. Incremental: many deltas, not one blob.
    assert (
        len(args) > 3
    ), f"args were not streamed incrementally ({len(args)} TOOL_CALL_ARGS event(s))"

    # 2. Correct: the concatenated deltas are the exact final arguments.
    joined = "".join(e.delta for e in args)
    try:
        parsed = json.loads(joined)
    except json.JSONDecodeError as exc:
        pytest.fail(
            f"concatenated TOOL_CALL_ARGS is not valid JSON ({exc}): {joined[:200]!r}"
        )
    assert parsed == EXPECTED_ARGS

    # 3. Ordered: START < ARGS... < END, and no other tool call was leaked.
    idx = {id(e): i for i, e in enumerate(events)}
    assert idx[id(starts[0])] < idx[id(args[0])] < idx[id(args[-1])] < idx[id(ends[0])]
    assert {e.tool_call_id for e in events if e.type == EventType.TOOL_CALL_ARGS} == {
        call_id
    }


@pytest.mark.parametrize(
    "resumable", [False, True], ids=["fire_and_forget", "resumable"]
)
async def test_agui_streams_parallel_tool_calls_independently(resumable: bool):
    """Interleaved fragments of two parallel calls must land on their own tool_call_id."""
    events = await _run_agui(
        streaming_flag=False, resumable=resumable, parallel_calls=2
    )

    assert not [e for e in events if e.type == EventType.RUN_ERROR]
    starts = [e for e in events if e.type == EventType.TOOL_CALL_START]
    assert len(starts) == 2, [str(e.type) for e in events]
    for index, start in enumerate(starts):
        cid = start.tool_call_id
        deltas = [
            e.delta
            for e in events
            if e.type == EventType.TOOL_CALL_ARGS and e.tool_call_id == cid
        ]
        assert len(deltas) > 3
        assert json.loads("".join(deltas)) == _arguments(index)
        assert (
            len(
                [
                    e
                    for e in events
                    if e.type == EventType.TOOL_CALL_END and e.tool_call_id == cid
                ]
            )
            == 1
        )
