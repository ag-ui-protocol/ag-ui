"""
A2UI subagent tool factory for LangGraph agents.

Thin adapter over ``ag-ui-a2ui-toolkit`` — the heavy lifting (op builders,
prompt assembly, history walkers, output envelope) lives in the toolkit so
each new framework adapter (ADK, Mastra, Strands, …) only owns the
framework-specific glue: tool decorator, runtime state access, model
binding + invoke.

Example usage in a chat node::

    from ag_ui_langgraph import get_a2ui_tools

    a2ui = get_a2ui_tools({"model": ChatOpenAI(model="gpt-4o")})

    model_with_tools = chat_model.bind_tools(
        [*state["tools"], a2ui],
        parallel_tool_calls=False,
    )
"""

from __future__ import annotations

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
    def generate_a2ui(
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

        def _invoke_subagent(prompt, _attempt):
            response = model_with_tool.invoke(
                [SystemMessage(content=prompt), *messages]
            )
            if not response.tool_calls:
                return None
            return response.tool_calls[0]["args"]

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
        result = run_a2ui_generation_with_recovery(
            base_prompt=prep["prompt"],
            catalog=catalog,
            config=recovery,
            invoke_subagent=_invoke_subagent,
            build_envelope=_build_envelope,
            on_attempt=on_a2ui_attempt,
        )
        return result["envelope"]

    return generate_a2ui
