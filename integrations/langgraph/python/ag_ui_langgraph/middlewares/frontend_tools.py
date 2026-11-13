"""Bridge AG-UI frontend tools into LangChain v1 ``create_agent()`` graphs.

Fixes `ag-ui-protocol/ag-ui#892
<https://github.com/ag-ui-protocol/ag-ui/issues/892>`_: a ``create_agent()``
graph binds only the tools passed at construction time, so a frontend tool
arriving in ``RunAgentInput.tools`` was never offered to the LLM -- the
integration merges those tools into ``state["tools"]``
(see ``LangGraphAgent.langgraph_default_merge_state``), but a plain
``create_agent()`` graph's ``AgentState`` has no ``tools`` channel, and
LangGraph silently drops the unknown input key before any node (or
middleware) ever sees it.

This middleware closes that gap in two halves, both following the hooks
LangChain v1 documents for dynamic tools:

* ``wrap_model_call`` merges the run's frontend tools into
  ``request.tools`` so the model is bound with them. The tools are read
  from the run config -- ``LangGraphAgent`` stashes
  ``RunAgentInput.tools`` under ``FRONTEND_TOOLS_CONFIG_KEY`` because the
  config is the one per-run channel every graph carries -- with a fallback
  to the graph state (``state["tools"]``, ``state["ag-ui"]["tools"]``,
  ``state["copilotkit"]["actions"]``) for hand-built graphs whose state
  schema does carry tools.
* ``after_model`` strips frontend tool calls out of the last ``AIMessage``
  before the tools node runs, so the backend never tries to execute a tool
  that only exists on the frontend (without this the tools node answers
  with a fabricated ``"<name> is not a valid tool"`` error, and the real
  result the client sends back is then discarded as a duplicate).
  The stripped calls are stashed per thread id and ``after_agent``
  restores them into the checkpoint message before the run ends, so the
  client's ``ToolMessage`` still matches the tool call it answers on the
  next turn. The client already received the call on the wire: the
  integration streams the model node's tool-call events before
  ``after_model`` runs.

Usage -- pass it to ``create_agent()`` alongside any other middleware::

    from langchain.agents import create_agent
    from ag_ui_langgraph import FrontendToolsMiddleware

    graph = create_agent(
        model=model,
        tools=[backend_tool],
        middleware=[FrontendToolsMiddleware()],
        checkpointer=MemorySaver(),
    )

The stash is instance state keyed by thread id (one middleware instance
serves one graph): it only has to survive from ``after_model`` to
``after_agent`` inside a single run, and it is dropped as soon as the
restore happens, so a later run on the same thread never sees a stale
entry. Runs without a thread id share the fallback key; the deployed path
always carries one.
"""

import logging
from typing import Any, Awaitable, Callable, Optional

from langchain.agents.middleware import AgentMiddleware, ModelRequest
from langchain_core.messages import AIMessage

logger = logging.getLogger(__name__)

#: Runnable-config key under which ``LangGraphAgent`` stashes the run's
#: frontend tools (plain ``Tool.model_dump()`` dicts). Namespaced so it
#: cannot collide with a user configurable key.
FRONTEND_TOOLS_CONFIG_KEY = "ag_ui_frontend_tools"

#: Fallback thread key for runs without a thread id (e.g. an in-memory
#: invoke with no checkpointer). Collisions across concurrent context-less
#: runs are an acceptable edge -- the deployed path always carries one.
_DEFAULT_THREAD_KEY = "__frontend_tools_default__"


def _current_thread_id() -> str:
    """Best-effort read of the active run's thread id from the LangGraph config."""
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        return (cfg.get("configurable") or {}).get("thread_id") or _DEFAULT_THREAD_KEY
    except Exception:  # noqa: BLE001 - no active context / older langgraph
        return _DEFAULT_THREAD_KEY


def _tool_name(tool: Any) -> Optional[str]:
    """The name of a tool in any of the shapes this module accepts."""
    if isinstance(tool, dict):
        fn = tool.get("function")
        if isinstance(fn, dict):
            return fn.get("name") or tool.get("name")
        return tool.get("name")
    return getattr(tool, "name", None)


def _normalize_tool(tool: Any) -> Any:
    """Normalize one frontend tool to a form ``bind_tools`` accepts.

    AG-UI ``Tool`` dicts (``Tool.model_dump()``) become a flat
    ``{"name", "description", "parameters"}`` dict; OpenAI-function-shaped
    dicts (``{"type": "function", "function": {...}}``) are flattened the
    same way; ``BaseTool`` instances and other dicts pass through
    untouched. Returns ``None`` for a tool without a name.
    """
    if isinstance(tool, dict):
        fn = tool.get("function")
        src = fn if isinstance(fn, dict) else tool
        name = src.get("name")
        if not name:
            return None
        if fn is not None and tool.get("type") not in (None, "function"):
            return tool
        normalized = {"name": name}
        if src.get("description"):
            normalized["description"] = src["description"]
        parameters = src.get("parameters")
        if isinstance(parameters, dict):
            normalized["parameters"] = parameters
        return normalized
    if hasattr(tool, "model_dump"):
        try:
            return _normalize_tool(tool.model_dump())
        except Exception:  # noqa: BLE001 - a broken dump must not kill the run
            logger.warning("frontend tool %r could not be dumped; skipping", tool)
            return None
    if _tool_name(tool):
        return tool
    return None


def _collect_frontend_tools(
    *,
    state: Optional[dict] = None,
    runtime: Any = None,
) -> list:
    """The run's frontend tools, de-duplicated by name, in first-seen order.

    Sources, in priority order: the LangGraph runtime context (which carries
    the run config's configurable keys), the active runnable config, then
    the graph state for graphs whose state schema carries tools.
    """
    tools: list = []
    seen: set = set()

    def _add(candidates: Any) -> None:
        if isinstance(candidates, dict):
            candidates = [candidates]
        if not isinstance(candidates, (list, tuple)):
            return
        for candidate in candidates:
            normalized = _normalize_tool(candidate)
            name = _tool_name(normalized) if normalized is not None else None
            if name and name not in seen:
                seen.add(name)
                tools.append(normalized)

    context = getattr(runtime, "context", None)
    if isinstance(context, dict):
        _add(context.get(FRONTEND_TOOLS_CONFIG_KEY))
    try:
        from langgraph.config import get_config

        cfg = get_config() or {}
        _add((cfg.get("configurable") or {}).get(FRONTEND_TOOLS_CONFIG_KEY))
    except Exception:  # noqa: BLE001 - no active context / older langgraph
        pass
    state = state or {}
    _add(state.get("tools"))
    ag_ui_state = state.get("ag-ui")
    if isinstance(ag_ui_state, dict):
        _add(ag_ui_state.get("tools"))
    copilotkit_state = state.get("copilotkit")
    if isinstance(copilotkit_state, dict):
        _add(copilotkit_state.get("actions"))
    return tools


def _frontend_tool_names(*, state: Optional[dict] = None, runtime: Any = None) -> set:
    return {
        name
        for name in (_tool_name(t) for t in _collect_frontend_tools(state=state, runtime=runtime))
        if name
    }


class FrontendToolsMiddleware(AgentMiddleware):
    """Offer AG-UI frontend tools to the model and keep them off the backend.

    See the module docstring for the full contract and usage.
    """

    def __init__(self) -> None:
        # (thread id) -> (AIMessage id, original tool_calls). Written by
        # after_model, consumed by after_agent, never outliving one run.
        self._intercepted: dict = {}

    # -- model binding -----------------------------------------------------

    def _tools_to_offer(self, request: ModelRequest) -> list:
        existing = {_tool_name(t) for t in (request.tools or [])}
        return [
            tool
            for tool in _collect_frontend_tools(state=request.state, runtime=request.runtime)
            if _tool_name(tool) not in existing
        ]

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        extra = self._tools_to_offer(request)
        if not extra:
            return handler(request)
        return handler(request.override(tools=[*request.tools, *extra]))

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        extra = self._tools_to_offer(request)
        if not extra:
            return await handler(request)
        return await handler(request.override(tools=[*request.tools, *extra]))

    # -- keep frontend calls off the backend tools node --------------------

    def _strip_frontend_calls(self, state: dict, runtime: Any) -> Optional[dict]:
        """State update removing frontend calls from the last AIMessage.

        Returns ``None`` when there is nothing to strip. The original calls
        are stashed (keyed by thread id) for ``after_agent`` to restore.
        """
        frontend_names = _frontend_tool_names(state=state, runtime=runtime)
        if not frontend_names:
            return None
        messages = (state or {}).get("messages") or []
        if not messages:
            return None
        last = messages[-1]
        if not isinstance(last, AIMessage):
            return None
        tool_calls = list(getattr(last, "tool_calls", None) or [])
        if not tool_calls:
            return None
        frontend_calls = [c for c in tool_calls if c.get("name") in frontend_names]
        if not frontend_calls:
            return None
        backend_calls = [c for c in tool_calls if c.get("name") not in frontend_names]
        thread_id = _current_thread_id()
        self._intercepted[thread_id] = (last.id, tool_calls)
        stripped = last.model_copy(update={"tool_calls": backend_calls})
        return {"messages": [stripped]}

    def after_model(self, state: dict, runtime: Any) -> Optional[dict]:
        return self._strip_frontend_calls(state, runtime)

    async def aafter_model(self, state: dict, runtime: Any) -> Optional[dict]:
        return self._strip_frontend_calls(state, runtime)

    # -- restore the intercepted calls into the checkpoint -----------------

    def _restore_intercepted_calls(self, state: dict) -> Optional[dict]:
        """State update putting the stashed calls back on their AIMessage.

        Returns ``None`` when nothing was intercepted on this thread.
        """
        thread_id = _current_thread_id()
        stashed = self._intercepted.pop(thread_id, None)
        if not stashed:
            return None
        message_id, original_calls = stashed
        messages = (state or {}).get("messages") or []
        updated = []
        found = False
        for message in messages:
            if isinstance(message, AIMessage) and message.id == message_id:
                updated.append(message.model_copy(update={"tool_calls": list(original_calls)}))
                found = True
            else:
                updated.append(message)
        if not found:
            return None
        return {"messages": updated}

    def after_agent(self, state: dict, runtime: Any) -> Optional[dict]:
        return self._restore_intercepted_calls(state)

    async def aafter_agent(self, state: dict, runtime: Any) -> Optional[dict]:
        return self._restore_intercepted_calls(state)
