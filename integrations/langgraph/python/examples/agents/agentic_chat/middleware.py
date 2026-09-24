"""CopilotKit middleware at the LangGraph Platform application-context boundary."""
from typing import Any

from copilotkit import CopilotKitMiddleware as BaseCopilotKitMiddleware
from langgraph.runtime import Runtime


class CopilotKitMiddleware(BaseCopilotKitMiddleware):
    def before_agent(self, state, runtime: Runtime[Any]):
        # Platform's V3 run endpoint adds these fields to configurable before
        # copying it into runtime.context. They are transport metadata, not
        # application context. Filter at the input boundary, before the base
        # middleware constructs a SystemMessage or the model sees it.
        # Explicit state.copilotkit.context still takes precedence unchanged.
        context = runtime.context
        if isinstance(context, dict) and context.get("__event_streaming_v2") is True:
            runtime = runtime.override(context={
                key: value for key, value in context.items()
                if key not in {"__event_streaming_v2", "thread_id"}
            })
        return super().before_agent(state, runtime)
