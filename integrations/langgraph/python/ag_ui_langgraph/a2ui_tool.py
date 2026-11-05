"""
A2UI subagent tool factory for LangGraph agents.

Thin adapter over ``ag-ui-a2ui-toolkit`` — the heavy lifting (op builders,
prompt assembly, history walkers, output envelope) lives in the toolkit so
each new framework adapter (ADK, Mastra, Strands, …) only owns the
framework-specific glue: tool decorator, runtime state access, model
binding + invoke.

Streaming: the subagent's ``render_a2ui`` call must STREAM to the AG-UI wire so
the a2ui middleware paints the surface progressively (the "building" skeleton
keys off the inner tool-call's arg deltas, not the final result). On LangGraph
this is FREE: the subagent runs ``model.astream`` inside the graph, so its
nested ``render_a2ui`` tool-call arg deltas surface natively as
``OnChatModelStream`` events, which the generic ``agent.py`` / ``agent.ts``
translator already turns into inner TOOL_CALL_START/ARGS/END. So this adapter
does NOT emit any A2UI-specific custom events — it just streams the subagent and
hands the accumulated args to the recovery loop. (Frameworks whose SDK does NOT
surface a nested model stream as wire events — e.g. Strands — own that explicit
push in their own adapter; LangGraph never needs it.)

Example usage in a chat node::

    from ag_ui_langgraph import get_a2ui_tools

    a2ui = get_a2ui_tools({"model": ChatOpenAI(model="gpt-4o")})

    model_with_tools = chat_model.bind_tools(
        [*state["tools"], a2ui],
        parallel_tool_calls=False,
    )
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Optional

from langchain.tools import tool, ToolRuntime
from langchain_core.messages import SystemMessage

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    A2UIGuidelines,
    A2UIToolParams,
    BASIC_CATALOG_ID,
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    resolve_a2ui_tool_params,
    wrap_error_envelope,
    run_a2ui_generation_with_recovery,
)

logger = logging.getLogger("ag_ui_langgraph")

# Recovery waits for model streams on the caller loop. Keep these blocking
# workers separate from the loop's default pool, which models can also use.
_recovery_executor = ThreadPoolExecutor(thread_name_prefix="ag-ui-a2ui-recovery")

#: Name of the render tool the A2UI middleware injects (and the subagent binds).
RENDER_A2UI_TOOL_NAME: str = RENDER_A2UI_TOOL_DEF["function"]["name"]


# Re-export the toolkit constants/types for callers that previously imported
# them from this package — keeps the public surface stable and lets consumers
# type the shared params object + its guidelines without depending on the
# toolkit package directly.
__all__ = [
    "get_a2ui_tools",
    "A2UI_OPERATIONS_KEY",
    "A2UIToolParams",
    "A2UIGuidelines",
    "BASIC_CATALOG_ID",
]


async def _stream_render_subagent(
    model_with_tool: Any,
    prompt: str,
    messages: list,
) -> Optional[dict]:
    """Run the structured-output subagent once and return the captured
    ``render_a2ui`` args — or ``None`` if the model produced no call.

    Uses ``astream`` (not ``invoke``) so the nested ``render_a2ui`` tool-call
    arg deltas surface natively as the graph's ``OnChatModelStream`` events —
    which the generic ``agent.py`` / ``agent.ts`` translator already turns into
    inner TOOL_CALL_START/ARGS/END, painting the surface progressively. This
    adapter emits NO A2UI-specific events: it merely consumes the stream to
    accumulate the final structured args for the recovery loop.
    """
    accumulated = None
    async for chunk in model_with_tool.astream(
        [SystemMessage(content=prompt), *messages]
    ):
        # Accumulate the streamed AIMessageChunks so the final parsed tool_calls
        # reconstruct even when each frame carries only an incremental arg
        # fragment. (Surfacing the deltas on the wire is langgraph's job, via
        # the OnChatModelStream events this astream emits.)
        accumulated = chunk if accumulated is None else accumulated + chunk

    if accumulated is None:
        return None
    tool_calls = getattr(accumulated, "tool_calls", None) or []
    for call in tool_calls:
        call_name = call.get("name") if isinstance(call, dict) else None
        if call_name in (None, RENDER_A2UI_TOOL_NAME):
            raw_args = call.get("args") if isinstance(call, dict) else None
            return raw_args if isinstance(raw_args, dict) else {}
    return None


def get_a2ui_tools(params: A2UIToolParams):
    """Build a LangGraph tool that delegates A2UI surface generation to a subagent.

    The returned tool is decorated with ``@langchain.tools.tool`` and is
    ready to bind into a chat model alongside any other tools.

    Args:
        params: Shared ``A2UIToolParams`` (``model`` + behavior knobs). The
            toolkit owns the shape and fills defaults via
            ``resolve_a2ui_tool_params``. Every framework adapter takes this
            exact params type — only the body below is LangGraph-specific, so a
            new knob added to ``A2UIToolParams`` reaches this adapter with no
            signature change.

    Returns:
        A LangGraph tool callable suitable for ``bind_tools(...)``.
    """
    # Shared: normalize knobs + fill canonical defaults so this adapter never
    # re-implements default logic. A new params field + its default lives
    # entirely in the toolkit.
    cfg = resolve_a2ui_tool_params(params)
    model = cfg["model"]
    guidelines = cfg["guidelines"]
    default_surface_id = cfg["default_surface_id"]
    default_catalog_id = cfg["default_catalog_id"]
    catalog = cfg["catalog"]
    recovery = cfg["recovery"]
    on_a2ui_attempt = cfg["on_a2ui_attempt"]

    @tool(cfg["tool_name"], description=cfg["tool_description"])
    async def generate_a2ui(
        runtime: ToolRuntime[Any],
        intent: str = "create",
        target_surface_id: Optional[str] = None,
        changes: Optional[str] = None,
    ) -> str:
        """Generate or edit an A2UI surface.

        Args:
            intent: Either ``"create"`` to render a new surface, or ``"update"``
                to modify a surface previously rendered in this conversation.
            target_surface_id: Required when ``intent="update"``. The surface
                id of the prior render to modify.
            changes: Optional natural-language description of the changes to
                apply when ``intent="update"``.
        """
        # Defensive: a custom state schema may not preseed ``messages``, and
        # ``state["messages"]`` would then raise KeyError mid-tool — mirror the
        # TS adapter's `state.messages ?? []` graceful-degrade.
        messages = runtime.state.get("messages", [])[:-1]

        # Shared: decide create/update, find prior surface, build the prompt.
        prep = prepare_a2ui_request(
            intent=intent,
            target_surface_id=target_surface_id,
            changes=changes,
            messages=messages,
            state=runtime.state,
            guidelines=guidelines,
        )
        if prep.get("error"):
            return wrap_error_envelope(prep["error"])

        # Glue: bind the structured-output tool.
        model_with_tool = model.bind_tools(
            [RENDER_A2UI_TOOL_DEF], tool_choice="render_a2ui"
        )

        async def _invoke_subagent(prompt, _attempt):
            return await _stream_render_subagent(model_with_tool, prompt, messages)

        def _build_envelope(args):
            return build_a2ui_envelope(
                args=args,
                is_update=prep["is_update"],
                target_surface_id=target_surface_id,
                prior=prep["prior"],
                default_surface_id=default_surface_id,
                default_catalog_id=default_catalog_id,
            )

        # Shared: validate->retry loop (mirrors the TS adapter). On each retry the
        # prompt is re-augmented with the prior attempt's structured errors; only a
        # validated surface is committed (the middleware gate suppresses any
        # unvalidated attempt, so a rejected one never paints). Returns a structured
        # hard-failure envelope once the attempt cap is hit.
        #
        # The recovery loop is synchronous, so run it in a worker thread. Send
        # each async model stream back to the caller's event loop: the model may
        # hold async connections already bound to that loop. The subagent's
        # astream still emits OnChatModelStream on the run, so the surface paints
        # progressively without this adapter emitting anything.
        caller_loop = asyncio.get_running_loop()

        def _invoke_on_caller_loop(prompt, attempt):
            future = asyncio.run_coroutine_threadsafe(
                _invoke_subagent(prompt, attempt), caller_loop
            )
            return future.result()

        def _run_recovery():
            return run_a2ui_generation_with_recovery(
                base_prompt=prep["prompt"],
                catalog=catalog,
                config=recovery,
                invoke_subagent=_invoke_on_caller_loop,
                build_envelope=_build_envelope,
                on_attempt=on_a2ui_attempt,
            )

        # Match asyncio.to_thread's context propagation for tracing and
        # callbacks while selecting a separate worker pool.
        context = contextvars.copy_context()
        result = await caller_loop.run_in_executor(
            _recovery_executor, context.run, _run_recovery
        )
        return result["envelope"]

    return generate_a2ui
