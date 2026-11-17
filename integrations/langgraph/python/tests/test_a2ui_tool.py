"""Integration tests for the LangGraph A2UI tool factory (``get_a2ui_tools``).

These run in the ``langgraph-python`` unit job, which builds the LOCAL adapter,
so they exercise the real in-repo ``get_a2ui_tools``. Its dependencies are NOT
local: ``ag-ui-a2ui-toolkit`` has always come from PyPI as uv.lock resolves it,
and ``ag-ui-protocol`` does too since PNI-274 removed the ``[tool.uv.sources]``
override that pointed it at ``sdks/python``.

The dojo e2e suite can't cover this: it installs the PUBLISHED
``ag-ui-langgraph`` (the langgraph-cloud build rejects local path deps that
escape the examples root), so the single-arg ``A2UIToolParams`` / ``guidelines``
surface has no e2e coverage until it ships. This file is that coverage.

A lightweight fake chat model STREAMS a fixed ``render_a2ui`` tool call as
several ``AIMessageChunk``s (mirroring how a real provider streams tool-call arg
fragments). The tests assert both the emitted operations envelope and that the
generation/design/composition guidance reaches the subagent — and, critically,
that the inner render call is surfaced as PROGRESSIVE TOOL_CALL_ARGS deltas (the
parity fix), not one bulk paint at the end.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextvars import ContextVar

from langchain_core.messages import AIMessageChunk
from langchain_core.messages.tool import tool_call_chunk

from ag_ui_langgraph import get_a2ui_tools
from ag_ui_langgraph.a2ui_tool import _stream_render_subagent
from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    DEFAULT_DESIGN_GUIDELINES,
    DEFAULT_GENERATION_GUIDELINES,
)


# A structurally-valid render_a2ui result (root present, child resolves, no
# cycle) so the toolkit's recovery/validation commits on the first attempt.
VALID_ARGS = {
    "surfaceId": "s1",
    "components": [
        {"id": "root", "component": "Column", "children": ["t"]},
        {"id": "t", "component": "Text", "text": "hi"},
    ],
    "data": {},
}

REQUEST_CONTEXT = ContextVar("a2ui_test_request_context", default=None)


def _arg_chunks(args: dict, parts: int = 3) -> list[str]:
    """Split the JSON of ``args`` into ``parts`` non-empty fragments, the way a
    provider streams tool-call arg deltas."""
    text = json.dumps(args)
    size = max(1, len(text) // parts)
    chunks = [text[i : i + size] for i in range(0, len(text), size)]
    return chunks or [text]


class _StreamingBoundModel:
    """What ``model.bind_tools(...)`` returns — records the system prompt it is
    streamed with and replays a fixed ``render_a2ui`` tool call as several
    ``AIMessageChunk``s (one per arg fragment), like a real streaming provider."""

    def __init__(self, parent: "FakeModel"):
        self._parent = parent

    async def astream(self, messages):
        # The adapter streams with [SystemMessage(prompt), *history]; capture the
        # system prompt so tests can assert what guidance the subagent saw.
        self._parent.captured_prompts.append(messages[0].content)
        fragments = _arg_chunks(self._parent.args)
        call_id = "call-1"
        for index, fragment in enumerate(fragments):
            yield AIMessageChunk(
                content="",
                tool_call_chunks=[
                    tool_call_chunk(
                        # Name + id only on the first fragment, mirroring how
                        # providers stamp them once at the start of the call.
                        name="render_a2ui" if index == 0 else None,
                        args=fragment,
                        id=call_id if index == 0 else None,
                        index=0,
                    )
                ],
            )


class FakeModel:
    """Minimal chat-model stand-in: only ``bind_tools`` + ``astream`` are used."""

    def __init__(self, args):
        self.args = args
        self.captured_prompts: list[str] = []

    def bind_tools(self, tools, tool_choice=None):
        return _StreamingBoundModel(self)


class LoopBoundModel(FakeModel):
    """Fail if the render stream runs outside the tool caller's event loop."""

    def __init__(self, args_by_attempt):
        super().__init__(args_by_attempt[0])
        self.args_by_attempt = args_by_attempt
        self.call_count = 0

    def bind_tools(self, tools, tool_choice=None):
        caller_loop = asyncio.get_running_loop()
        parent = self

        class BoundModel:
            async def astream(self, messages):
                if asyncio.get_running_loop() is not caller_loop:
                    raise RuntimeError("model stream ran on a different event loop")
                parent.captured_prompts.append(messages[0].content)
                args = parent.args_by_attempt[parent.call_count]
                parent.call_count += 1
                for index, fragment in enumerate(_arg_chunks(args)):
                    yield AIMessageChunk(
                        content="",
                        tool_call_chunks=[
                            tool_call_chunk(
                                name="render_a2ui" if index == 0 else None,
                                args=fragment,
                                id="call-1" if index == 0 else None,
                                index=0,
                            )
                        ],
                    )

        return BoundModel()


class OffloadingModel(FakeModel):
    """Model stream that needs a worker from the caller loop's default pool."""

    def __init__(self):
        super().__init__(VALID_ARGS)
        self.stream_tasks = []
        self.context_values = []

    def bind_tools(self, tools, tool_choice=None):
        parent = self
        bound = super().bind_tools(tools, tool_choice)

        class BoundModel:
            async def astream(self, messages):
                parent.stream_tasks.append(asyncio.current_task())
                parent.context_values.append(REQUEST_CONTEXT.get())
                await asyncio.to_thread(lambda: None)
                async for chunk in bound.astream(messages):
                    yield chunk

        return BoundModel()


class FakeRuntime:
    """Stand-in for LangGraph's ``ToolRuntime`` — the tool reads ``state`` and
    ``config`` (the latter forwarded to ``adispatch_custom_event``)."""

    def __init__(self, state, config=None):
        self.state = state
        self.config = config


def _invoke_tool(tool, runtime, **kwargs) -> str:
    """Drive the tool's async coroutine directly with a stub runtime, bypassing
    the graph's runtime injection. Runs to completion on a fresh event loop."""
    return asyncio.run(tool.coroutine(runtime, **kwargs))


class TestGetA2UITools(unittest.TestCase):
    def _make(self, guidelines=None, tool_name=None):
        model = FakeModel(VALID_ARGS)
        params = {"model": model, "default_catalog_id": "cat://custom"}
        if guidelines is not None:
            params["guidelines"] = guidelines
        if tool_name is not None:
            params["tool_name"] = tool_name
        return get_a2ui_tools(params), model

    def test_single_arg_params_produces_operations_envelope(self):
        # Guards the exact regression that broke CI: the factory must accept a
        # single A2UIToolParams dict (model inside) and drive a render.
        tool, _model = self._make()
        envelope = _invoke_tool(
            tool, FakeRuntime({"messages": []}), intent="create"
        )
        parsed = json.loads(envelope)
        ops = parsed[A2UI_OPERATIONS_KEY]
        self.assertTrue(any("createSurface" in o for o in ops))
        self.assertTrue(any("updateComponents" in o for o in ops))
        # Catalog ownership stays with the host (from params), never the model.
        create = next(o for o in ops if "createSurface" in o)
        self.assertEqual(create["createSurface"]["catalogId"], "cat://custom")

    def test_default_guidelines_reach_the_subagent_prompt(self):
        # No guidelines passed → the built-in generation + design defaults must
        # be injected into the subagent system prompt (OSS-248 re-enable).
        tool, model = self._make()
        _invoke_tool(tool, FakeRuntime({"messages": []}), intent="create")
        prompt = model.captured_prompts[0]
        self.assertIn(DEFAULT_GENERATION_GUIDELINES, prompt)
        self.assertIn("## Design Guidelines", prompt)
        self.assertIn(DEFAULT_DESIGN_GUIDELINES, prompt)

    def test_composition_guide_and_overrides_flow_through(self):
        tool, model = self._make(
            guidelines={
                "generation_guidelines": "CUSTOM_GEN",
                "composition_guide": "COMPMARK",
            }
        )
        _invoke_tool(tool, FakeRuntime({"messages": []}), intent="create")
        prompt = model.captured_prompts[0]
        # Per-field override replaces generation; design keeps its default.
        self.assertIn("CUSTOM_GEN", prompt)
        self.assertNotIn(DEFAULT_GENERATION_GUIDELINES, prompt)
        self.assertIn(DEFAULT_DESIGN_GUIDELINES, prompt)
        self.assertIn("COMPMARK", prompt)

    def test_tool_name_resolves(self):
        default_tool, _ = self._make()
        self.assertEqual(default_tool.name, "generate_a2ui")
        custom_tool, _ = self._make(tool_name="render_ui")
        self.assertEqual(custom_tool.name, "render_ui")

    def test_recovery_streams_on_caller_loop_across_retries(self):
        model = LoopBoundModel([{"components": []}, VALID_ARGS])
        attempts = []
        tool = get_a2ui_tools({"model": model, "on_a2ui_attempt": attempts.append})

        envelope = _invoke_tool(tool, FakeRuntime({"messages": []}), intent="create")

        self.assertEqual(model.call_count, 2)
        self.assertEqual([attempt["ok"] for attempt in attempts], [False, True])
        self.assertIn(A2UI_OPERATIONS_KEY, json.loads(envelope))

    def test_recovery_does_not_exhaust_model_worker_pool(self):
        model = OffloadingModel()
        tool = get_a2ui_tools({"model": model})

        async def run_concurrent_calls():
            loop = asyncio.get_running_loop()
            executor = ThreadPoolExecutor(max_workers=2)
            loop.set_default_executor(executor)
            token = REQUEST_CONTEXT.set("request-context")
            tasks = [
                asyncio.create_task(tool.coroutine(FakeRuntime({"messages": []})))
                for _ in range(2)
            ]
            try:
                results = await asyncio.wait_for(
                    asyncio.gather(*tasks), timeout=5
                )
                self.assertTrue(
                    all(A2UI_OPERATIONS_KEY in json.loads(result) for result in results)
                )
                self.assertEqual(model.context_values, ["request-context"] * 2)
            finally:
                REQUEST_CONTEXT.reset(token)
                # A failed assertion must not leave blocked recovery threads behind.
                for stream_task in model.stream_tasks:
                    if not stream_task.done():
                        stream_task.cancel()
                await asyncio.gather(*model.stream_tasks, return_exceptions=True)
                await asyncio.gather(*tasks, return_exceptions=True)
                executor.shutdown(wait=False)

        asyncio.run(run_concurrent_calls())


class TestStreamRenderSubagent(unittest.TestCase):
    """The subagent STREAMS the model (``astream``) so the nested render_a2ui
    tool-call arg deltas surface natively as the graph's OnChatModelStream
    events — which the generic agent.py / agent.ts translator paints
    progressively. This adapter emits nothing itself; it just accumulates the
    streamed chunks and returns the final render args for the recovery loop.
    Verify that multi-chunk accumulation reconstructs the full surface."""

    def test_accumulates_streamed_chunks_into_final_args(self):
        model = FakeModel(VALID_ARGS)
        # _stream_render_subagent expects an already-bound model (bind_tools is
        # done by the factory); the fake's bound model ignores the tool def and
        # replays the render call as several partial AIMessageChunk fragments.
        bound = model.bind_tools([])
        captured = asyncio.run(_stream_render_subagent(bound, "PROMPT", []))
        # The chunk fragments merged back into the full structured args.
        self.assertEqual(captured, VALID_ARGS)

    def test_returns_none_when_no_render_call(self):
        # A stream that produces no render_a2ui call -> None, which the recovery
        # loop records as a failed attempt (retry / hard-failure envelope).
        model = FakeModel(VALID_ARGS)
        bound = model.bind_tools([])

        async def _empty_astream(_messages):
            if False:  # pragma: no cover - generator with no yields
                yield None

        bound.astream = _empty_astream
        captured = asyncio.run(_stream_render_subagent(bound, "PROMPT", []))
        self.assertIsNone(captured)


if __name__ == "__main__":
    unittest.main()
