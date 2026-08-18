"""Utilities for forwarding client-defined tools to the Strands agent at runtime."""

from __future__ import annotations

import logging
from threading import Lock
from typing import TYPE_CHECKING, Any, Callable, Mapping, Set

from ag_ui.core import Tool as AgUiTool
from strands import ToolContext
from strands import tool as strands_tool
from strands.tools.registry import ToolRegistry
from strands.tools.tools import PythonAgentTool
from strands.types.tools import AgentTool, ToolResult, ToolSpec, ToolUse

from .frontend_tool_wait import (
    FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
    frontend_tool_wait_reason,
    unwrap_frontend_tool_response,
)

if TYPE_CHECKING:
    from .config import ToolBehavior

logger = logging.getLogger(__name__)

# Attribute set on proxy tools so we can distinguish them from native tools.
_PROXY_MARKER = "_ag_ui_proxy"

# Placeholder result the proxy returns server-side. The real result is produced
# on the client and reconciled back in on the following run.
PROXY_RESULT_PLACEHOLDER = "Forwarded to client"

# Public callers that omit the new behavior mapping retain the pre-feature
# all-placeholder behavior. An explicitly supplied mapping, including an empty
# one, opts into behavior-by-name resolution.
_TOOL_BEHAVIORS_OMITTED: Any = object()


def _tool_spec(ag_ui_tool: Any) -> tuple[str, str, ToolSpec]:
    name: str = (
        ag_ui_tool.name
        if isinstance(ag_ui_tool, AgUiTool)
        else ag_ui_tool.get("name", "")
    )
    description: str = (
        ag_ui_tool.description
        if isinstance(ag_ui_tool, AgUiTool)
        else ag_ui_tool.get("description", "")
    )
    parameters: Any = (
        ag_ui_tool.parameters
        if isinstance(ag_ui_tool, AgUiTool)
        else ag_ui_tool.get("parameters", {})
    )
    return (
        name,
        description,
        {
            "name": name,
            "description": description,
            "inputSchema": {"json": parameters or {}},
        },
    )


def _create_interrupting_proxy(
    ag_ui_tool: Any,
    *,
    allowed_native_tool_use_ids: frozenset[str] | None = None,
    on_resolved: Callable[[str], None] | None = None,
) -> AgentTool:
    """Build an interrupting proxy, optionally restricted to parked IDs."""
    name, description, tool_spec = _tool_spec(ag_ui_tool)

    @strands_tool(
        name=name,
        description=description,
        inputSchema=tool_spec["inputSchema"],
        context=True,
    )
    def _interrupting_proxy(tool_context: ToolContext) -> ToolResult:
        native_tool_use_id = tool_context.tool_use["toolUseId"]
        if (
            allowed_native_tool_use_ids is not None
            and native_tool_use_id not in allowed_native_tool_use_ids
        ):
            raise ValueError(
                "frontend wait resume proxy received an untracked native "
                f"tool use id: {native_tool_use_id}"
            )
        response = tool_context.interrupt(
            FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
            reason=frontend_tool_wait_reason(native_tool_use_id=native_tool_use_id),
        )
        content, is_error = unwrap_frontend_tool_response(response)
        if on_resolved is not None:
            on_resolved(native_tool_use_id)
        return {
            "toolUseId": native_tool_use_id,
            "status": "error" if is_error else "success",
            "content": [{"text": content}],
        }

    proxy: AgentTool = _interrupting_proxy
    proxy.mark_dynamic()
    setattr(proxy, _PROXY_MARKER, True)
    return proxy


def create_proxy_tool(
    ag_ui_tool: AgUiTool, *, continue_after_frontend_call: bool = True
) -> AgentTool:
    """Convert an AG-UI ``Tool`` into a Strands proxy tool.

    The resulting tool is marked as dynamic so it can be hot-reloaded and is
    distinguishable from tools registered at server startup.

    Args:
        ag_ui_tool: Tool definition received from the client via ``RunAgentInput.tools``.
        continue_after_frontend_call: Whether to return the legacy placeholder
            rather than wait for a native frontend-tool interrupt response.

    Returns:
        A dynamic Strands tool that the LLM can call.
    """
    name, _, tool_spec = _tool_spec(ag_ui_tool)

    if continue_after_frontend_call:

        def _proxy_func(tool_use: ToolUse, **_kwargs: Any) -> ToolResult:
            return {
                "toolUseId": tool_use["toolUseId"],
                "status": "success",
                "content": [{"text": PROXY_RESULT_PLACEHOLDER}],
            }

        # ToolFunc protocol requires __name__
        _proxy_func.__name__ = name

        proxy: AgentTool = PythonAgentTool(
            tool_name=name,
            tool_spec=tool_spec,
            tool_func=_proxy_func,
        )
    else:
        return _create_interrupting_proxy(ag_ui_tool)

    proxy.mark_dynamic()
    setattr(proxy, _PROXY_MARKER, True)
    return proxy


def _replace_registered_tool(
    tool_registry: ToolRegistry,
    name: str,
    replacement: AgentTool | None,
) -> None:
    """Replace one exact registry entry without leaving dynamic metadata."""
    tool_registry.registry.pop(name, None)
    tool_registry.dynamic_tools.pop(name, None)
    if replacement is not None:
        tool_registry.register_tool(replacement)


class _FrontendWaitResumeProxyOverlay:
    """Temporarily route only persisted parked IDs through interrupt proxies."""

    def __init__(self, tool_registry: ToolRegistry) -> None:
        self._tool_registry = tool_registry
        self._lock = Lock()
        self._fallbacks: dict[str, AgentTool | None] = {}
        self._pending_ids: dict[str, set[str]] = {}

    def install(
        self,
        ag_ui_tools: list[AgUiTool],
        native_ids_by_name: Mapping[str, set[str]],
    ) -> None:
        definitions = {
            (
                tool.name if isinstance(tool, AgUiTool) else tool.get("name", "")  # type: ignore[union-attr]
            ): tool
            for tool in ag_ui_tools
        }
        try:
            for name, native_ids in native_ids_by_name.items():
                if not native_ids:
                    continue
                self._fallbacks[name] = self._tool_registry.registry.get(name)
                self._pending_ids[name] = set(native_ids)
                definition = definitions.get(name) or {
                    "name": name,
                    "description": "Pending frontend tool resume",
                    "parameters": {},
                }
                proxy = _create_interrupting_proxy(
                    definition,
                    allowed_native_tool_use_ids=frozenset(native_ids),
                    on_resolved=lambda native_id, tool_name=name: self._resolved(
                        tool_name, native_id
                    ),
                )
                _replace_registered_tool(self._tool_registry, name, proxy)
        except BaseException:
            self.restore()
            raise

    def _resolved(self, name: str, native_tool_use_id: str) -> None:
        with self._lock:
            pending = self._pending_ids.get(name)
            if pending is None or native_tool_use_id not in pending:
                raise ValueError(
                    "frontend wait resume proxy resolved an untracked native "
                    f"tool use id: {native_tool_use_id}"
                )
            pending.remove(native_tool_use_id)
            if not pending:
                self._restore_name(name)

    def _restore_name(self, name: str) -> None:
        fallback = self._fallbacks.pop(name)
        self._pending_ids.pop(name, None)
        _replace_registered_tool(self._tool_registry, name, fallback)

    def restore(self) -> None:
        """Restore every current-request tool exactly once."""
        with self._lock:
            for name in list(self._fallbacks):
                self._restore_name(name)


def _install_frontend_wait_resume_proxy_overlay(
    tool_registry: ToolRegistry,
    ag_ui_tools: list[AgUiTool],
    native_ids_by_name: Mapping[str, set[str]],
) -> _FrontendWaitResumeProxyOverlay:
    overlay = _FrontendWaitResumeProxyOverlay(tool_registry)
    overlay.install(ag_ui_tools, native_ids_by_name)
    return overlay


def _is_proxy(tool: Any) -> bool:
    """Return True if *tool* was created by ``create_proxy_tool``."""
    return getattr(tool, _PROXY_MARKER, False) is True


def sync_proxy_tools(
    tool_registry: ToolRegistry,
    ag_ui_tools: list[AgUiTool],
    tracked_names: Set[str],
    *,
    tool_behaviors: Mapping[str, "ToolBehavior"] = _TOOL_BEHAVIORS_OMITTED,
) -> Set[str]:
    """Synchronise proxy tools in *tool_registry* with *ag_ui_tools*.

    * New tools present in *ag_ui_tools* but absent from the registry are
      registered (unless a native, non-proxy tool with the same name exists).
    * Stale proxy tools that are in *tracked_names* but absent from the
      incoming list are removed.

    Args:
        tool_registry: The Strands ``ToolRegistry`` attached to the agent.
        ag_ui_tools: Tool definitions from the current ``RunAgentInput.tools``.
        tracked_names: Set of proxy tool names registered in previous calls.
        tool_behaviors: Resolved behavior configuration keyed by tool name. If
            omitted, every proxy retains legacy placeholder behavior. An
            explicit mapping defaults names absent from it to interrupt mode.

    Returns:
        Updated set of proxy tool names currently registered.
    """
    desired_names: Set[str] = set()
    for t in ag_ui_tools:
        n = t.name if isinstance(t, AgUiTool) else t.get("name", "")  # type: ignore[union-attr]
        if n:
            desired_names.add(n)

    # --- Remove stale proxy tools ---
    stale = tracked_names - desired_names
    for name in stale:
        existing = tool_registry.registry.get(name)
        if existing is not None and _is_proxy(existing):
            del tool_registry.registry[name]
            tool_registry.dynamic_tools.pop(name, None)
            logger.debug("Removed stale proxy tool: %s", name)

    # --- Add / update proxy tools ---
    current_proxy_names: Set[str] = set()
    for t in ag_ui_tools:
        n = t.name if isinstance(t, AgUiTool) else t.get("name", "")  # type: ignore[union-attr]
        if not n:
            continue

        existing = tool_registry.registry.get(n)
        if existing is not None and not _is_proxy(existing):
            # Native tool – do not overwrite.
            logger.debug("Skipping proxy for native tool: %s", n)
            continue

        if tool_behaviors is _TOOL_BEHAVIORS_OMITTED:
            continue_after_frontend_call = True
        else:
            behavior = tool_behaviors.get(n)
            continue_after_frontend_call = (
                behavior is not None and behavior.continue_after_frontend_call is True
            )
        proxy = create_proxy_tool(
            t,
            continue_after_frontend_call=continue_after_frontend_call,
        )
        tool_registry.register_tool(proxy)
        current_proxy_names.add(n)
        logger.debug("Registered proxy tool: %s", n)

    return current_proxy_names
