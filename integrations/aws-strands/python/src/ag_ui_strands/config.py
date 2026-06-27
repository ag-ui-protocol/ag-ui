"""Configuration primitives for customizing Strands agent behavior."""

from __future__ import annotations

import inspect
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    Iterable,
    List,
    Optional,
)

from ag_ui.core import RunAgentInput

from strands.session import SessionManager


StatePayload = Dict[str, Any]


@dataclass
class ToolCallContext:
    """Context passed to tool call hooks."""

    input_data: RunAgentInput
    tool_name: str
    tool_use_id: str
    tool_input: Any
    args_str: str


@dataclass
class ToolResultContext(ToolCallContext):
    """Context passed to tool result hooks."""

    result_data: Any
    message_id: str


ArgsStreamer = Callable[[ToolCallContext], AsyncIterator[str]]
StateFromArgs = Callable[[ToolCallContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
StateFromResult = Callable[[ToolResultContext], Awaitable[Optional[StatePayload]] | Optional[StatePayload]]
CustomResultHandler = Callable[[ToolResultContext], AsyncIterator[Any]]
StateContextBuilder = Callable[[RunAgentInput, str], str]
SessionManagerProvider = Callable[[RunAgentInput], Awaitable[Optional[SessionManager]] | Optional[SessionManager]]


@dataclass
class PredictStateMapping:
    """Declarative mapping telling the UI how to predict state from tool args."""

    state_key: str
    tool: str
    tool_argument: str

    def to_payload(self) -> Dict[str, str]:
        return {
            "state_key": self.state_key,
            "tool": self.tool,
            "tool_argument": self.tool_argument,
        }


@dataclass
class ToolBehavior:
    """Declarative configuration for tool-specific handling."""

    skip_messages_snapshot: bool = False
    """When True, suppress the ``MessagesSnapshotEvent`` that would normally
    follow this tool's ``TOOL_CALL_END`` / ``TOOL_CALL_RESULT`` events.

    Useful when ``custom_result_handler`` already emits its own
    ``MessagesSnapshotEvent`` and you want to avoid duplicates.
    """
    continue_after_frontend_call: bool = False
    stop_streaming_after_result: bool = False
    predict_state: Optional[Iterable[PredictStateMapping]] = None
    args_streamer: Optional[ArgsStreamer] = None
    state_from_args: Optional[StateFromArgs] = None
    state_from_result: Optional[StateFromResult] = None
    custom_result_handler: Optional[CustomResultHandler] = None


@dataclass
class StrandsAgentConfig:
    """Top-level configuration for the Strands agent adapter."""

    tool_behaviors: Dict[str, ToolBehavior] = field(default_factory=dict)
    state_context_builder: Optional[StateContextBuilder] = None
    session_manager_provider: Optional[SessionManagerProvider] = None
    """Optional factory for creating per-thread SessionManager instances.

    Called exactly once per thread_id the first time that thread is seen.
    Subsequent requests on the same thread reuse the cached agent (and its
    SessionManager). If the provider depends on per-request data (e.g. auth
    tokens in ``forwarded_props``), be aware that only the first request's
    data is used to initialise the session manager.

    If the provider raises an exception the run yields a ``RUN_ERROR`` event
    and returns early; the thread is NOT cached so the provider will be
    retried on the next request.

    If the provider returns ``None`` a warning is logged and the agent runs
    without session persistence; the thread IS cached in this state, so the
    provider will not be called again for the same thread.
    """
    emit_messages_snapshot: bool = True
    """Emit ``MessagesSnapshotEvent`` at lifecycle boundaries (after the
    initial state snapshot, after each ``TOOL_CALL_END`` /
    ``TOOL_CALL_RESULT``, and after each ``TEXT_MESSAGE_END``).

    Required for CopilotKit v2 frontends, which key tool-call rendering
    off canonical message reconstruction rather than the streaming
    ``TOOL_CALL_*`` events alone. Set to False for raw AG-UI consumers
    that do their own message reconstruction.
    """
    replay_history_into_strands: bool = True
    """When True (and the cached Strands agent has no ``session_manager``),
    reconcile the per-thread ``StrandsAgentCore.messages`` list with
    ``RunAgentInput.messages`` before invoking ``stream_async``.

    This prevents the LLM from re-firing frontend tools every turn
    because Strands' internal history was missing the tool result that
    the frontend produced. Disable only if you manage Strands history
    yourself (e.g. via a custom ``session_manager``).
    """
    reuse_agent: bool = False
    """Run the wrapped Agent directly instead of cloning a fresh per-thread
    ``StrandsAgentCore`` from it.

    By default the adapter treats the wrapped Agent as a *template* and builds
    one fresh instance per ``thread_id`` so that concurrent threads in a single
    long-lived process cannot corrupt each other's mutable state. That rebuild
    goes through ``_extract_agent_kwargs``, which reconstructs the agent from the
    constructor params it can read back off the instance — a lossy round-trip:
    anything Strands does not retain as a public attribute is silently dropped.
    ``plugins`` is the clearest casualty (Strands keeps them in a private
    ``_plugin_registry`` and discards the original list), so a wrapped Agent
    built with ``plugins=[...]`` loses them entirely.

    In a per-invocation / per-session-isolated runtime — e.g. AWS Bedrock
    AgentCore, where each session runs in its own microVM and the host already
    constructs a fresh Agent per request — the per-thread clone is redundant:
    isolation is provided by the runtime, and the clone's only observable effect
    is dropping plugins (and any other construct that does not round-trip). Set
    this ``True`` in those deployments to run the wrapped Agent as-is, which
    preserves plugins without the ``agent.plugins = ...`` re-exposure workaround.

    Precondition: one ``StrandsAgent`` must serve a single thread / one
    concurrent run. The adapter mutates the agent in place each turn (it
    overwrites ``.messages``, registers proxy/A2UI tools on ``.tool_registry``,
    and writes ``.state``), so sharing one Agent across concurrent threads under
    this flag would cause cross-talk. ``session_manager_provider`` is *not*
    consulted in this mode; configure hooks and a ``session_manager`` directly on
    the Strands ``Agent`` (``Agent(hooks=..., session_manager=...)``) instead.
    """
    a2ui: Optional[Dict[str, Any]] = None
    """A2UI auto-injection config — everything A2UI-related in one
    place. When the CopilotKit runtime forwards ``injectA2UITool`` (or
    ``a2ui["inject_a2ui_tool"]`` opts in on a host that doesn't), the adapter
    injects a ``generate_a2ui`` recovery tool and infers the model from the
    wrapped agent — no manual ``get_a2ui_tools()`` needed. Keys:

    - ``inject_a2ui_tool`` — opt in without the runtime flag; a string also
      names the injected render tool to drop.
    - ``default_catalog_id`` — catalog id stamped into auto-injected surfaces
      (must match the host renderer's catalog).
    - ``guidelines`` — ``{"composition_guide": ...}`` teaches the sub-agent the
      catalog's components; required for a real model to compose them.
    - ``catalog`` — inline catalog for catalog-aware (semantic) recovery.
    - ``recovery`` — recovery loop config. NOTE: keys are camelCase per the
      shared toolkit contract — e.g. ``{"maxAttempts": 5}`` (a snake_case
      ``max_attempts`` is silently ignored).
    """


async def maybe_await(value: Any) -> Any:
    """Await coroutine-like values produced by hook callables."""

    if inspect.isawaitable(value):
        return await value
    return value


def normalize_predict_state(value: Optional[Iterable[PredictStateMapping]]) -> List[PredictStateMapping]:
    """Normalize predict state config into a concrete list."""

    if value is None:
        return []
    if isinstance(value, PredictStateMapping):
        return [value]
    return list(value)

