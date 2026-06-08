"""
A2UI subagent tool factory for LangGraph agents.

Thin adapter over ``ag-ui-a2ui-toolkit`` — the heavy lifting (op builders,
prompt assembly, history walkers, output envelope) lives in the toolkit so
each new framework adapter (ADK, Mastra, Strands, …) only owns the
framework-specific glue: tool decorator, runtime state access, model
binding + invoke.

Example usage in a chat node::

    from ag_ui_langgraph import get_a2ui_tools

    a2ui = get_a2ui_tools(model=ChatOpenAI(model="gpt-4o"))

    model_with_tools = chat_model.bind_tools(
        [*state["tools"], a2ui],
        parallel_tool_calls=False,
    )
"""

from __future__ import annotations

from typing import Any, Optional

from langchain.tools import tool, ToolRuntime
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import SystemMessage

from ag_ui_a2ui_toolkit import (
    A2UI_OPERATIONS_KEY,
    BASIC_CATALOG_ID,
    DEFAULT_SURFACE_ID,
    GENERATE_A2UI_TOOL_NAME,
    GENERATE_A2UI_TOOL_DESCRIPTION,
    RENDER_A2UI_TOOL_DEF,
    build_a2ui_envelope,
    prepare_a2ui_request,
    wrap_error_envelope,
    run_a2ui_generation_with_recovery,
)


# Re-export the toolkit constants for callers that previously imported them
# from this package — keeps the public surface stable.
__all__ = [
    "get_a2ui_tools",
    "A2UI_OPERATIONS_KEY",
    "BASIC_CATALOG_ID",
]


def get_a2ui_tools(
    model: BaseChatModel,
    *,
    composition_guide: Optional[str] = None,
    default_surface_id: str = DEFAULT_SURFACE_ID,
    default_catalog_id: str = BASIC_CATALOG_ID,
    tool_name: str = GENERATE_A2UI_TOOL_NAME,
    tool_description: Optional[str] = None,
    catalog: Optional[dict] = None,
    recovery: Optional[dict] = None,
    on_a2ui_attempt: Optional[Any] = None,
):
    """Build a LangGraph tool that delegates A2UI surface generation to a subagent.

    The returned tool is decorated with ``@langchain.tools.tool`` and is
    ready to bind into a chat model alongside any other tools.

    Args:
        model: Chat model the subagent will invoke for structured A2UI output.
            Using the same provider/model as the main agent is fine.
        composition_guide: Optional extra rules appended to the subagent's
            system prompt (e.g. project-specific component usage rules).
        default_surface_id: Surface id used when the subagent omits ``surfaceId``.
        default_catalog_id: Catalog id assigned to every new surface this
            factory creates — the subagent never picks the catalog. Falls back
            to the basic v0.9 catalog.
        tool_name: Name advertised to the main agent's planner.
        tool_description: Description shown to the main agent's planner.

    Returns:
        A LangGraph tool callable suitable for ``bind_tools(...)``.
    """

    description = tool_description or GENERATE_A2UI_TOOL_DESCRIPTION

    @tool(tool_name, description=description)
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
            composition_guide=composition_guide,
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
