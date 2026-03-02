"""
Custom middleware helpers for CopilotKit agents.
"""
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from langchain.agents.middleware import AgentMiddleware, ModelRequest
from langchain_core.messages import ToolMessage
from langchain_core.runnables.config import ensure_config, var_child_runnable_config


def _with_intermediate_state(config: dict, emit_intermediate_state: list) -> dict:
    metadata = {**config.get("metadata", {}), "predict_state": emit_intermediate_state}
    return {**config, "metadata": metadata}


@dataclass
class StateItem:
    state_key: str
    tool: str
    tool_argument: str

class StateStreamingMiddleware(AgentMiddleware):
    def __init__(self, *items: StateItem) -> None:
        self._emit_intermediate_state = [
            {"state_key": i.state_key, "tool": i.tool, "tool_argument": i.tool_argument}
            for i in items
        ]

    def _is_pre_tool_call(self, request: ModelRequest) -> bool:
        """Return True if this model call may generate the initial tool call.

        When the last message is a ToolMessage the tool has already run and the
        model is being called for a follow-up response.  Injecting
        emit_intermediate_state in that case causes predict_state streaming to
        fire again if the model decides to call the same tool a second time,
        producing a duplicate stream.
        """
        msgs = request.messages
        return not (msgs and isinstance(msgs[-1], ToolMessage))

    def wrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Any],
    ) -> Any:
        if not self._is_pre_tool_call(request):
            return handler(request)
        config = _with_intermediate_state(ensure_config(), self._emit_intermediate_state)
        token = var_child_runnable_config.set(config)
        try:
            return handler(request)
        finally:
            var_child_runnable_config.reset(token)

    async def awrap_model_call(
        self,
        request: ModelRequest,
        handler: Callable[[ModelRequest], Awaitable[Any]],
    ) -> Any:
        pre = self._is_pre_tool_call(request)
        if not pre:
            return await handler(request)
        config = _with_intermediate_state(ensure_config(), self._emit_intermediate_state)
        token = var_child_runnable_config.set(config)
        try:
            return await handler(request)
        finally:
            var_child_runnable_config.reset(token)