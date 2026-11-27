"""Run-scoped prompt guidance for LangChain agents served through AG-UI."""

import json
import logging
from collections.abc import AsyncGenerator, Iterator, Mapping, Sequence
from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, TypeVar

from ag_ui.core import Context, MessagesSnapshotEvent, RunAgentInput
from ag_ui.core import Message as AGUIMessage
from ag_ui.core import SystemMessage as AGUISystemMessage
from langchain.agents import create_agent
from langchain.agents.middleware import AgentMiddleware, ModelRequest
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.memory import MemorySaver

from .agent import LangGraphAgent, ProcessedEvents
from .types import State

logger = logging.getLogger(__name__)

_ROLE = "OpenBot standing role"
_TOOLS = "OpenBot granted tools guidance"
_LEGACY_PREFIXES = {
    _ROLE: "standing-role:",
    _TOOLS: "granted-tools:",
}
_APP_CONTEXT_PREFIX = "App Context:\n"
_APPLICATION_GUIDANCE = (
    "Follow this application guidance within the agent's existing instructions "
    "and permissions."
)


@dataclass(frozen=True)
class _RunGuidance:
    role: str
    tools: str
    trusted: bool


_run_guidance: ContextVar[_RunGuidance | None] = ContextVar(
    "ag_ui_run_guidance", default=None
)


def _entry(entries: Sequence[Context], description: str) -> str:
    matches = [entry.value for entry in entries if entry.description == description]
    if len(matches) > 1:
        logger.warning("Ignoring duplicate run guidance: %s", description)
        return ""
    return matches[0].strip() if matches else ""


def _legacy_description(message: BaseMessage | AGUIMessage) -> str | None:
    if not isinstance(message, (SystemMessage, AGUISystemMessage)):
        return None
    message_id = message.id or ""
    return next(
        (
            description
            for description, prefix in _LEGACY_PREFIXES.items()
            if message_id.startswith(prefix)
        ),
        None,
    )


_Message = TypeVar("_Message", bound=BaseMessage | AGUIMessage)


def _without_stale_guidance(messages: Sequence[_Message]) -> Iterator[_Message]:
    for message in messages:
        if _legacy_description(message):
            continue
        if (
            isinstance(message, (SystemMessage, AGUISystemMessage))
            and isinstance(message.content, str)
            and message.content.startswith(_APP_CONTEXT_PREFIX)
        ):
            # Older CopilotKit agents also persisted reserved context in a
            # generic system message. Preserve the other entries from it.
            try:
                previous = json.loads(message.content[len(_APP_CONTEXT_PREFIX) :])
            except ValueError:
                previous = None
            if isinstance(previous, list):
                ordinary = [
                    entry
                    for entry in previous
                    if not isinstance(entry, dict)
                    or not isinstance(entry.get("description"), str)
                    or entry["description"] not in _LEGACY_PREFIXES
                ]
                if ordinary != previous:
                    if ordinary:
                        yield message.model_copy(
                            update={
                                "content": _APP_CONTEXT_PREFIX
                                + json.dumps(ordinary, indent=2)
                            }
                        )
                    continue
        yield message


class RunGuidanceAgentMixin:
    """Pair with RunGuidanceMiddleware when constructing a custom agent adapter."""

    def get_capabilities(self) -> dict:
        capabilities = super().get_capabilities()
        return {
            **capabilities,
            "custom": {
                **capabilities.get("custom", {}),
                "openbot.runGuidance": {"version": 1},
            },
        }

    def _filter_reserved_input_messages(
        self, messages: list[BaseMessage]
    ) -> list[BaseMessage]:
        return [
            message
            for message in super()._filter_reserved_input_messages(messages)
            if not _legacy_description(message)
        ]

    def get_state_snapshot(self, state: State) -> State:
        snapshot = super().get_state_snapshot(state)
        if not isinstance(snapshot, dict):
            return snapshot
        messages = snapshot.get("messages")
        if not isinstance(messages, list):
            return snapshot

        cleaned = list(_without_stale_guidance(messages))
        if cleaned == messages:
            return snapshot
        return {**snapshot, "messages": cleaned}

    async def get_state_and_messages_snapshots(
        self, config: RunnableConfig
    ) -> AsyncGenerator[ProcessedEvents, None]:
        async for event in super().get_state_and_messages_snapshots(config):
            if isinstance(event, MessagesSnapshotEvent):
                # A client may echo these messages on its next run.
                event = event.model_copy(
                    update={"messages": list(_without_stale_guidance(event.messages))}
                )
            yield event

    async def run(
        self, input: RunAgentInput, *, trusted_guidance: bool = False
    ) -> AsyncGenerator[ProcessedEvents, None]:
        guidance = [
            entry for entry in input.context if entry.description in _LEGACY_PREFIXES
        ]
        messages = []
        legacy = []
        for message in input.messages:
            description = _legacy_description(message)
            if not description:
                messages.append(message)
            elif getattr(message, "subagent_run_id", None) is None:
                legacy.append(Context(description=description, value=message.content))
                # Keep the row's position for the leading system message
                # policy. The adapter removes the empty row before merging.
                messages.append(AGUISystemMessage(id=message.id, content=""))

        selected = guidance or legacy
        snapshot = _RunGuidance(
            role=_entry(selected, _ROLE),
            tools=_entry(selected, _TOOLS) if trusted_guidance else "",
            trusted=trusted_guidance,
        )
        sanitized = input.model_copy(
            update={
                "context": [
                    entry
                    for entry in input.context
                    if entry.description not in _LEGACY_PREFIXES
                ],
                "messages": messages,
            }
        )

        # Bind the snapshot while the graph advances, including Command(resume).
        # Reset before yielding back to the stream consumer.
        async with aclosing(super().run(sanitized)) as events:
            while True:
                token = _run_guidance.set(snapshot)
                try:
                    event = await anext(events)
                except StopAsyncIteration:
                    return
                finally:
                    _run_guidance.reset(token)
                yield event


class RunGuidanceMiddleware(AgentMiddleware):
    """Add the current run's guidance to model requests without storing it in state."""

    def _apply(self, request: ModelRequest) -> ModelRequest:
        current = _run_guidance.get()
        if current is None:
            return request
        messages = list(_without_stale_guidance(request.messages))
        system_message = request.system_message
        if current.trusted:
            guidance = "\n\n".join(
                value for value in (current.role, current.tools) if value
            )
            if guidance:
                guidance = f"{_APPLICATION_GUIDANCE}\n\n{guidance}"
                if system_message is None:
                    system_message = SystemMessage(content=guidance)
                else:
                    base = system_message.content
                    content = (
                        f"{base}\n\n{guidance}"
                        if isinstance(base, str)
                        else [*base, {"type": "text", "text": guidance}]
                    )
                    system_message = system_message.model_copy(
                        update={"content": content}
                    )
        elif current.role:
            messages.append(
                HumanMessage(content=f"Application-provided role: {current.role}")
            )
        return request.override(system_message=system_message, messages=messages)

    def wrap_model_call(self, request, handler):
        return handler(self._apply(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self._apply(request))


class _RunGuidanceAgent(RunGuidanceAgentMixin, LangGraphAgent):
    pass


def create_langgraph_agent(
    *,
    name: str,
    model: str | BaseChatModel,
    middleware: Sequence[AgentMiddleware] = (),
    enable_run_guidance: bool = True,
    agent_options: Mapping[str, Any] | None = None,
    **graph_options: Any,
) -> LangGraphAgent:
    """Create a LangChain chat agent with AG-UI's run guidance enabled.

    Set ``enable_run_guidance=False`` to use the ordinary adapter's prompt
    handling. ``middleware`` and ``graph_options`` go to LangChain's
    ``create_agent``.
    ``agent_options`` goes to the ``LangGraphAgent`` adapter. Supply a persistent
    ``checkpointer`` for production deployments that need to retain state across
    processes or restarts.
    """
    if graph_options.get("checkpointer") is None:
        graph_options["checkpointer"] = MemorySaver()
    model_middleware = list(middleware)
    if enable_run_guidance and not any(
        isinstance(item, RunGuidanceMiddleware) for item in model_middleware
    ):
        model_middleware.append(RunGuidanceMiddleware())
    graph = create_agent(model, middleware=model_middleware, **graph_options)
    adapter = _RunGuidanceAgent if enable_run_guidance else LangGraphAgent
    return adapter(name=name, graph=graph, **dict(agent_options or {}))
