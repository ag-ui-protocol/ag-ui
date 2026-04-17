import logging
import re
import uuid
import json
from typing import Optional, List, Any, Union, AsyncGenerator, Generator, Literal, Dict, TypedDict
from typing_extensions import NotRequired, Self
import inspect

from langgraph.graph.state import CompiledStateGraph

try:
    from langchain.schema import BaseMessage, SystemMessage, ToolMessage
except ImportError:
    # Langchain >= 1.0.0
    from langchain_core.messages import BaseMessage, SystemMessage, ToolMessage
    
from langchain_core.runnables import RunnableConfig, ensure_config
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.types import Command

from .types import (
    State,
    MessagesInProgressRecord,
    SchemaKeys,
    MessageInProgress,
    RunMetadata,
    LangGraphEventTypes,
    CustomEventNames,
    LangGraphReasoning
)
from .utils import (
    agui_messages_to_langchain,
    DEFAULT_SCHEMA_KEYS,
    filter_object_by_schema_keys,
    get_stream_payload_input,
    langchain_messages_to_agui,
    resolve_reasoning_content,
    resolve_encrypted_reasoning_content,
    resolve_message_content,
    camel_to_snake,
    json_safe_stringify,
    make_json_safe,
    normalize_tool_content
)

from ag_ui.core import (
    EventType,
    CustomEvent,
    MessagesSnapshotEvent,
    RawEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ToolCallResultEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
)
from ag_ui.encoder import EventEncoder

ProcessedEvents = Union[
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ReasoningStartEvent,
    ReasoningMessageStartEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningEndEvent,
    ReasoningEncryptedValueEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
    MessagesSnapshotEvent,
    RawEvent,
    CustomEvent,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    StepStartedEvent,
    StepFinishedEvent,
]

logger = logging.getLogger(__name__)

ROOT_SUBGRAPH_NAME = "root"


class PreparedStream(TypedDict):
    """Payload returned by prepare_stream / prepare_regenerate_stream.

    ``stream`` is the graph's ``astream_events`` async iterator (or ``None``
    when the caller should only dispatch ``events_to_dispatch`` and return).
    ``state`` and ``config`` mirror the state and config used to build the
    stream. ``events_to_dispatch`` is an optional list of pre-built events
    for the short-circuit path (e.g. active interrupts with no resume).
    """
    stream: Optional[Any]
    state: Optional[Any]
    config: Optional[RunnableConfig]
    events_to_dispatch: NotRequired[Optional[List[ProcessedEvents]]]

class LangGraphAgent:
    def __init__(self, *, name: str, graph: CompiledStateGraph, description: Optional[str] = None, config:  Union[Optional[RunnableConfig], dict] = None):
        self.name = name
        self.description = description
        self.graph = graph
        self.config = config or {}
        self.messages_in_process: MessagesInProgressRecord = {}
        self.active_run: Optional[RunMetadata] = None
        self.constant_schema_keys = ['messages', 'tools']
        # Collect nodes bound to a CompiledStateGraph: those are the declared
        # subgraphs whose boundaries we attribute events to during streaming
        # (so mid-stream MESSAGES_SNAPSHOT can fire at the right transitions).
        # Nodes bound to plain callables / runnables are intentionally excluded.
        self.subgraphs: set = {
            name for name, node in self.graph.nodes.items()
            if isinstance(getattr(node, 'bound', None), CompiledStateGraph)
        }
        self.current_subgraph = ROOT_SUBGRAPH_NAME

    def clone(self) -> Self:
        """Create a fresh copy with clean per-request state.

        Subclasses that add required __init__ parameters must override clone()
        to pass those parameters through.
        """
        try:
            return type(self)(
                name=self.name,
                graph=self.graph,
                description=self.description,
                config=dict(self.config) if self.config else None,
            )
        except TypeError as exc:
            raise TypeError(
                f"{type(self).__name__} must override clone() or ensure its "
                f"__init__ accepts (name, graph, description, config) as "
                f"keyword arguments: {exc}"
            ) from exc

    def _dispatch_event(self, event: ProcessedEvents) -> ProcessedEvents:
        if event.type == EventType.RAW:
            event.event = make_json_safe(event.event)
        elif event.raw_event:
            event.raw_event = make_json_safe(event.raw_event)

        return event

    async def run(self, input: RunAgentInput) -> AsyncGenerator[str, None]:
        forwarded_props = {}
        if hasattr(input, "forwarded_props") and input.forwarded_props:
            forwarded_props = {
                camel_to_snake(k): v for k, v in input.forwarded_props.items()
            }
        async for event_str in self._handle_stream_events(input.copy(update={"forwarded_props": forwarded_props})):
            yield event_str

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[str, None]:
        thread_id = input.thread_id or str(uuid.uuid4())
        INITIAL_ACTIVE_RUN: RunMetadata = {
            "id": input.run_id,
            "thread_id": thread_id,
            "mode": "start",
            "reasoning_process": None,
            "node_name": None,
            "has_function_streaming": False,
            "model_made_tool_call": False,
            "state_reliable": True,
            "streamed_messages": [],
            "any_mid_stream_merge_fired": False,
        }
        self.active_run = INITIAL_ACTIVE_RUN
        try:

            forwarded_props = input.forwarded_props
            node_name_input = forwarded_props.get('node_name', None) if forwarded_props else None

            self.active_run["manually_emitted_state"] = None

            config = ensure_config(self.config.copy() if self.config else {})
            config["configurable"] = {**(config.get('configurable', {})), "thread_id": thread_id}

            agent_state = await self.graph.aget_state(config)
            resume_input = forwarded_props.get('command', {}).get('resume', None)

            if resume_input is None and thread_id and self.active_run.get("node_name") != "__end__" and self.active_run.get("node_name"):
                self.active_run["mode"] = "continue"
            else:
                self.active_run["mode"] = "start"

            prepared_stream_response = await self.prepare_stream(input=input, agent_state=agent_state, config=config)

            yield self._dispatch_event(
                RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=self.active_run["id"])
            )
            self.handle_node_change(node_name_input)

            # In case of resume (interrupt), re-start resumed step
            if resume_input and self.active_run.get("node_name"):
                for ev in self.handle_node_change(self.active_run.get("node_name")):
                    yield ev

            state = prepared_stream_response["state"]
            stream = prepared_stream_response["stream"]
            config = prepared_stream_response["config"]
            events_to_dispatch = prepared_stream_response.get('events_to_dispatch', None)

            if events_to_dispatch is not None and len(events_to_dispatch) > 0:
                for event in events_to_dispatch:
                    yield self._dispatch_event(event)
                return

            should_exit = False
            current_graph_state = state

            async for event in stream:
                subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True
                ns = (event.get("metadata") or {}).get("langgraph_checkpoint_ns", "")
                # Derive which subgraph (if any) owns this event.
                # ns format: "" | "node:uuid" | "node:uuid|inner:uuid"
                # Only the outermost namespace matters here — we just need to
                # know which declared subgraph owns the event for boundary
                # transitions; inner-graph nesting doesn't affect that decision.
                ns_root = ns.split("|")[0].split(":")[0] if ns else ""
                current_subgraph = ns_root if ns_root in self.subgraphs else None

                # Legacy detection (LangGraph < 0.6): subgraph events use stream mode names as event types
                is_subgraph_stream = (subgraphs_stream_enabled and (
                    event.get("event", "").startswith("events") or
                    event.get("event", "").startswith("values")
                ))
                # Modern detection (LangGraph >= 0.6): subgraph if inside one (|) or at its boundary
                if not is_subgraph_stream and ("|" in ns or current_subgraph is not None):
                    is_subgraph_stream = True

                graph_context = current_subgraph if current_subgraph else ROOT_SUBGRAPH_NAME

                if is_subgraph_stream and current_subgraph != self.current_subgraph:
                    self.current_subgraph = current_subgraph
                    # Every time a subgraph changes, we need to update the state and messages snapshots.
                    # Record that a mid-stream merge fired: the post-run
                    # snapshot must preserve these streamed_messages
                    # (delivered to the client here) rather than wiping
                    # them with a checkpoint-only final snapshot.
                    self.active_run["any_mid_stream_merge_fired"] = True
                    async for ev in self.get_state_and_messages_snapshots(config):
                        yield ev

                if event["event"] == "error":
                    yield self._dispatch_event(
                        RunErrorEvent(type=EventType.RUN_ERROR, message=event["data"]["message"], raw_event=event)
                    )
                    break

                current_node_name = (event.get("metadata") or {}).get("langgraph_node")
                event_type = event.get("event")
                event_run_id = event.get("run_id")
                if isinstance(event_run_id, str) and event_run_id:
                    self.active_run["id"] = event_run_id
                elif event_run_id is not None:
                    # Shape mismatch: some upstream emitted a non-string run_id.
                    # Keep the existing id rather than corrupting it.
                    logger.warning(
                        "Ignoring non-string run_id on event (type=%r, run_id=%r)",
                        event_type,
                        event_run_id,
                    )
                exiting_node = False

                if event_type == "on_chain_end" and isinstance(
                        event.get("data", {}).get("output"), dict
                ):
                    output = event["data"]["output"]
                    current_graph_state.update(output)
                    exiting_node = self.active_run["node_name"] == current_node_name
                    # If output contains any key outside the protocol-internal set
                    # ("messages", "tools", "ag-ui"), the local current_graph_state
                    # is reliably up-to-date again.
                    if any(k not in ("messages", "tools", "ag-ui") for k in output):
                        self.active_run["state_reliable"] = True

                should_exit = should_exit or (
                        event_type == "on_custom_event" and
                        event["name"] == "exit"
                    )

                if current_node_name and current_node_name != self.active_run.get("node_name"):
                    for ev in self.handle_node_change(current_node_name):
                        yield ev

                # Track whether the current model turn is making a predict_state tool
                # call so we can suppress the model-node exit snapshot.  The model-node
                # exit fires *before* the tool runs, so current_graph_state still
                # carries the previous value — emitting it would wipe predict_state
                # progress on the client.  This applies to every iteration, not just
                # the first.  Note: _handle_single_event uses the same predict_state
                # metadata check to emit the PredictState custom event — keep both
                # sites in sync if the check logic changes.
                if event_type == LangGraphEventTypes.OnChatModelStream.value:
                    chunk = event.get("data", {}).get("chunk") or {}
                    tool_call_chunks = (
                        chunk.get("tool_call_chunks") or []
                        if isinstance(chunk, dict)
                        else getattr(chunk, "tool_call_chunks", None) or []
                    )
                    if tool_call_chunks:
                        first = tool_call_chunks[0]
                        first_name = (
                            first.get("name") if isinstance(first, dict)
                            else getattr(first, "name", None)
                        )
                        if first_name:
                            predict_state_meta = (event.get("metadata") or {}).get("predict_state", [])
                            tool_used_to_predict_state = any(
                                (p.get("tool") if isinstance(p, dict) else getattr(p, "tool", None)) == first_name
                                for p in predict_state_meta
                            )
                            if tool_used_to_predict_state:
                                self.active_run["model_made_tool_call"] = True

                # Explicit ``is None`` check: an empty dict (``{}``) is a
                # legitimate manually-emitted state ("reset to empty") and must
                # not be silently coerced back to current_graph_state by a
                # truthy ``or`` fallback.
                manually_emitted = self.active_run.get("manually_emitted_state")
                updated_state = manually_emitted if manually_emitted is not None else current_graph_state
                has_state_diff = updated_state != state
                if exiting_node or (has_state_diff and not self.get_message_in_progress(self.active_run["id"])):
                    state = updated_state
                    self.active_run["prev_node_name"] = self.active_run["node_name"]
                    current_graph_state.update(updated_state)
                    mmtc = self.active_run.get("model_made_tool_call")
                    state_reliable = self.active_run.get("state_reliable", True)
                    suppressed = exiting_node and (mmtc or not state_reliable)
                    if suppressed:
                        logger.debug(
                            "Suppressing node-exit STATE_SNAPSHOT (node=%s, model_made_tool_call=%s, state_reliable=%s)",
                            self.active_run.get("node_name"),
                            mmtc,
                            state_reliable,
                        )
                        self.active_run["model_made_tool_call"] = False
                        if mmtc:
                            # A predict_state tool call was detected — the tool has
                            # not yet run, so current_graph_state does not yet reflect
                            # the forthcoming state update.
                            self.active_run["state_reliable"] = False
                    else:
                        yield self._dispatch_event(
                            StateSnapshotEvent(
                                type=EventType.STATE_SNAPSHOT,
                                snapshot=self.get_state_snapshot(state),
                                raw_event=event,
                            )
                        )

                yield self._dispatch_event(
                    RawEvent(type=EventType.RAW, event=event)
                )

                async for single_event in self._handle_single_event(event, state):
                    yield single_event

            state = await self.graph.aget_state(config)

            tasks = state.tasks if len(state.tasks) > 0 else None
            interrupts = tasks[0].interrupts if tasks else []

            # state.metadata can be None on freshly-initialised / empty checkpoints,
            # which would AttributeError on .get — coerce to empty dict first.
            state_metadata = state.metadata or {}
            writes = state_metadata.get("writes", {}) or {}
            node_name = self.active_run["node_name"] if interrupts else next(iter(writes), None)
            next_nodes = state.next or ()
            is_end_node = len(next_nodes) == 0 and not interrupts

            node_name = "__end__" if is_end_node else node_name

            for interrupt in interrupts:
                yield self._dispatch_event(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=LangGraphEventTypes.OnInterrupt.value,
                        value=dump_json_safe(interrupt.value),
                        raw_event=interrupt,
                    )
                )

            if self.active_run.get("node_name") != node_name:
                for ev in self.handle_node_change(node_name):
                    yield ev

            # Post-run MESSAGES_SNAPSHOT semantics:
            #
            # - Runs where no mid-stream boundary snapshot fired: the
            #   checkpoint is the authoritative final state. Do NOT merge
            #   in ``streamed_messages`` — they include transient LLM
            #   outputs (``.with_structured_output()`` / router /
            #   classifier calls) that never committed, and their
            #   presence here shows up as duplicate / empty assistant
            #   bubbles in the final snapshot.
            #
            # - Runs where at least one mid-stream boundary snapshot
            #   fired: keep the ``streamed_messages`` merge. Those
            #   messages were already delivered to the client via the
            #   mid-stream snapshots and must remain visible in the
            #   final snapshot; the parent graph often returns
            #   ``Command(goto=...)`` without folding them into state,
            #   so the checkpoint alone is incomplete.
            any_mid_stream_merge_fired = self.active_run.get(
                "any_mid_stream_merge_fired", False
            )
            async for ev in self.get_state_and_messages_snapshots(
                config, merge_streamed_messages=any_mid_stream_merge_fired
            ):
                yield ev

            for ev in self.handle_node_change(None):
                yield ev

            yield self._dispatch_event(
                RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=self.active_run["id"])
            )
        finally:
            self.active_run = None

    async def prepare_stream(self, input: RunAgentInput, agent_state: State, config: RunnableConfig) -> PreparedStream:
        # Invariant: prepare_stream is only called from _handle_stream_events
        # after self.active_run has been initialized for the current run.
        assert self.active_run is not None, "prepare_stream called outside an active run"
        state_input = input.state or {}
        messages = input.messages or []
        forwarded_props = input.forwarded_props or {}
        thread_id = input.thread_id

        state_input["messages"] = agent_state.values.get("messages", [])
        langchain_messages = agui_messages_to_langchain(messages)
        state = self.langgraph_default_merge_state(state_input, langchain_messages, input)
        config["configurable"]["thread_id"] = thread_id
        interrupts = agent_state.tasks[0].interrupts if agent_state.tasks and len(agent_state.tasks) > 0 else []
        has_active_interrupts = len(interrupts) > 0
        resume_input = forwarded_props.get('command', {}).get('resume', None)

        self.active_run["schema_keys"] = self.get_schema_keys(config)

        non_system_messages = [msg for msg in langchain_messages if not isinstance(msg, SystemMessage)]
        if len(agent_state.values.get("messages", [])) > len(non_system_messages):
            # Only trigger time-travel regeneration if the incoming messages are NOT already
            # in the checkpoint. If they are, this is a continuation (e.g. after CopilotKit
            # intercepted a tool call), not a time-travel edit — regenerating would loop.
            #
            # We exclude ToolMessages from the ID comparison because CopilotKit assigns new
            # IDs to tool results that won't match the placeholder IDs AgentCoreMemorySaver
            # wrote to the checkpoint. Human and AI message IDs are stable across requests
            # and are sufficient to distinguish continuation from time-travel.
            incoming_non_tool_ids = {
                getattr(m, "id", None)
                for m in langchain_messages
                if getattr(m, "id", None) and not isinstance(m, ToolMessage)
            }
            checkpoint_ids = {getattr(m, "id", None) for m in agent_state.values.get("messages", []) if getattr(m, "id", None)}
            is_continuation = bool(incoming_non_tool_ids) and incoming_non_tool_ids.issubset(checkpoint_ids)

            if not is_continuation:
                last_user_message: Optional[HumanMessage] = None
                for i in range(len(langchain_messages) - 1, -1, -1):
                    candidate = langchain_messages[i]
                    if isinstance(candidate, HumanMessage):
                        last_user_message = candidate
                        break

                if last_user_message:
                    last_user_id = last_user_message.id
                    if last_user_id and last_user_id in checkpoint_ids:
                        return await self.prepare_regenerate_stream(
                            input=input,
                            message_checkpoint=last_user_message,
                            config=config
                        )

        events_to_dispatch = []
        if has_active_interrupts and not resume_input:
            events_to_dispatch.append(
                RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=self.active_run["id"])
            )

            for interrupt in interrupts:
                events_to_dispatch.append(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=LangGraphEventTypes.OnInterrupt.value,
                        value=dump_json_safe(interrupt.value),
                        raw_event=interrupt,
                    )
                )

            events_to_dispatch.append(
                RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=self.active_run["id"])
            )
            return {
                "stream": None,
                "state": None,
                "config": None,
                "events_to_dispatch": events_to_dispatch,
            }

        if self.active_run["mode"] == "continue":
            await self.graph.aupdate_state(config, state, as_node=self.active_run.get("node_name"))

        if resume_input:
            if isinstance(resume_input, str):
                try:
                    resume_input = json.loads(resume_input)
                except json.JSONDecodeError:
                    # Keep as string if not valid JSON — callers may legitimately
                    # pass raw string resume payloads.
                    logger.debug(
                        "failed to parse resume_input as JSON, treating as string"
                    )
            stream_input = Command(resume=resume_input)
        else:
            payload_input = get_stream_payload_input(
                mode=self.active_run["mode"],
                state=state,
                schema_keys=self.active_run["schema_keys"],
            )
            stream_input = {**forwarded_props, **payload_input} if payload_input else None


        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True

        kwargs = self.get_stream_kwargs(
            input=stream_input,
            config=config,
            subgraphs=bool(subgraphs_stream_enabled),
            version="v2",
        )

        stream = self.graph.astream_events(**kwargs)

        return {
            "stream": stream,
            "state": state,
            "config": config
        }

    async def prepare_regenerate_stream( # pylint: disable=too-many-arguments
            self,
            input: RunAgentInput,
            message_checkpoint: HumanMessage,
            config: RunnableConfig
    ) -> Optional[PreparedStream]:
        tools = input.tools or []
        thread_id = input.thread_id

        # ``HumanMessage.id`` is Optional at the type level; narrow here so
        # downstream typed parameters (``get_checkpoint_before_message``'s
        # ``message_id: str``) hold. Callers reach this method only after
        # verifying the id against a checkpoint, so a missing id represents
        # a programming error rather than a recoverable state.
        message_id = message_checkpoint.id
        if not message_id:
            raise ValueError(
                "prepare_regenerate_stream requires a message_checkpoint with an id"
            )
        if not thread_id:
            raise ValueError(
                "prepare_regenerate_stream requires input.thread_id to locate the fork point"
            )

        # ``get_checkpoint_before_message`` raises ``ValueError`` when the
        # message id is missing from history; it never returns ``None``, so
        # no None-guard is needed here.
        time_travel_checkpoint = await self.get_checkpoint_before_message(message_id, thread_id, config)

        # Time-travel regeneration forks at a single ``as_node`` target. When the
        # checkpoint's ``next`` tuple has more than one entry (a parallel/fan-out
        # branch), we pick the first one and surface the choice via a warning so
        # operators can see the non-determinism rather than have branches
        # silently dropped.
        next_nodes = time_travel_checkpoint.next or ()
        if len(next_nodes) > 1:
            logger.warning(
                "time-travel checkpoint has multiple next nodes %r; "
                "forking only at %r (other branches are not replayed)",
                next_nodes, next_nodes[0],
            )
        fork = await self.graph.aupdate_state(
            time_travel_checkpoint.config,
            time_travel_checkpoint.values,
            as_node=next_nodes[0] if next_nodes else "__start__",
        )

        stream_input = self.langgraph_default_merge_state(time_travel_checkpoint.values, [message_checkpoint], input)
        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs', True) if input.forwarded_props else True

        kwargs = self.get_stream_kwargs(
            input=stream_input,
            config=fork,
            subgraphs=bool(subgraphs_stream_enabled),
            version="v2",
        )
        stream = self.graph.astream_events(**kwargs)

        return {
            "stream": stream,
            "state": time_travel_checkpoint.values,
            "config": config
        }

    def get_message_in_progress(self, run_id: str) -> Optional[MessageInProgress]:
        return self.messages_in_process.get(run_id)

    def set_message_in_progress(self, run_id: str, data: MessageInProgress) -> None:
        current_message_in_progress = self.messages_in_process.get(run_id) or {}
        self.messages_in_process[run_id] = {
            **current_message_in_progress,
            **data,
        }

    def get_schema_keys(self, config: RunnableConfig) -> SchemaKeys:
        try:
            input_schema = self.graph.get_input_jsonschema(config)
            output_schema = self.graph.get_output_jsonschema(config)
            config_schema = self.graph.config_schema().schema()

            input_schema_keys = list(input_schema["properties"].keys()) if "properties" in input_schema else []
            output_schema_keys = list(output_schema["properties"].keys()) if "properties" in output_schema else []
            config_schema_keys = list(config_schema["properties"].keys()) if "properties" in config_schema else []

            # context_schema introspection is best-effort and independent of the
            # input/output/config triple above — if it raises, keep the keys we
            # already computed rather than falling back all four to defaults.
            # (NOTE: the exception tuple is intentionally kept in sync with the
            # outer except below; core sibling is widening that tuple separately.)
            context_schema_keys: List[str] = []
            if hasattr(self.graph, "context_schema") and self.graph.context_schema is not None:
                try:
                    context_schema = self.graph.context_schema().schema()
                    context_schema_keys = list(context_schema["properties"].keys()) if "properties" in context_schema else []
                except (AttributeError, TypeError, KeyError) as ctx_exc:
                    logger.warning(
                        "get_schema_keys: context_schema introspection failed (%s: %s); "
                        "falling back to empty context keys while keeping input/output/config",
                        type(ctx_exc).__name__, ctx_exc,
                    )

            return {
                "input": [*input_schema_keys, *self.constant_schema_keys],
                "output": [*output_schema_keys, *self.constant_schema_keys],
                "config": config_schema_keys,
                "context": context_schema_keys,
            }
        except (AttributeError, TypeError, KeyError) as exc:
            # Legitimate fallback cases:
            #   AttributeError — graph doesn't implement schema introspection
            #     (older LangGraph versions, custom graph classes, or Pydantic v1/v2
            #     `.schema()` vs `.model_json_schema()` skew).
            #   TypeError      — a schema call returned an unexpected shape
            #     (e.g. not a mapping, so `"properties" in ...` / `.keys()` blows up).
            #   KeyError       — expected keys missing from an otherwise-dict schema.
            # Other exceptions (RuntimeError, I/O, asyncio, etc.) indicate real bugs
            # and are allowed to propagate rather than being silently swallowed.
            logger.warning(
                "get_schema_keys: falling back to default schema keys due to %s: %s",
                type(exc).__name__,
                exc,
            )
            return {
                "input": self.constant_schema_keys,
                "output": self.constant_schema_keys,
                "config": [],
                "context": [],
            }

    def langgraph_default_merge_state(self, state: State, messages: List[BaseMessage], input: RunAgentInput) -> State:
        if messages and isinstance(messages[0], SystemMessage):
            messages = messages[1:]

        # At runtime ``state["messages"]`` holds LangChain BaseMessage subclasses
        # (HumanMessage / AIMessage / ToolMessage / SystemMessage) — not the
        # TypedDict LangGraphPlatformMessage wire-shape. Annotate accordingly
        # so downstream attribute access (``.tool_calls``, ``.content``) type-checks.
        existing_messages: List[BaseMessage] = state.get("messages", [])

        # Fix tool_call args that are strings instead of dicts.
        # This happens when CopilotKit's after_agent restores frontend tool_calls
        # and the checkpoint saves them with string args. Bedrock Converse API
        # requires toolUse.input to be a JSON object (dict).
        for msg in existing_messages:
            if isinstance(msg, AIMessage) and getattr(msg, 'tool_calls', None):
                for tc in msg.tool_calls:
                    if isinstance(tc.get('args'), str):
                        try:
                            tc['args'] = json.loads(tc['args'])
                        except (json.JSONDecodeError, TypeError):
                            tc['args'] = {}

        # Fix orphan ToolMessages injected by patch_orphan_tool_calls:
        # Find the real content from AG-UI messages and replace the fake content.
        # Only scan from the last HumanMessage to the end of existing_messages.
        # Track replaced tool_call_ids so we don't also add the AG-UI duplicate.
        agui_tool_content = {
            m.tool_call_id: m.content
            for m in messages
            if isinstance(m, ToolMessage) and hasattr(m, 'tool_call_id')
        }
        replaced_tool_call_ids = set()
        if agui_tool_content:
            last_human_idx = -1
            for i in range(len(existing_messages) - 1, -1, -1):
                if isinstance(existing_messages[i], HumanMessage):
                    last_human_idx = i
                    break
            if last_human_idx >= 0:
                for i in range(last_human_idx + 1, len(existing_messages)):
                    msg = existing_messages[i]
                    if (
                            isinstance(msg, ToolMessage)
                            and isinstance(msg.content, str)
                            and self._ORPHAN_TOOL_MSG_RE.match(msg.content)
                            and hasattr(msg, 'tool_call_id')
                            and msg.tool_call_id in agui_tool_content
                    ):
                        msg.content = agui_tool_content[msg.tool_call_id]
                        replaced_tool_call_ids.add(msg.tool_call_id)

        existing_message_ids = {msg.id for msg in existing_messages}

        new_messages = [
            msg for msg in messages
            if msg.id not in existing_message_ids
        ]

        tools = input.tools or []
        tools_as_dicts = []
        if tools:
            for tool in tools:
                if hasattr(tool, "model_dump"):
                    tools_as_dicts.append(tool.model_dump())
                elif hasattr(tool, "dict"):
                    tools_as_dicts.append(tool.dict())
                else:
                    tools_as_dicts.append(tool)

        all_tools = [*state.get("tools", []), *tools_as_dicts]

        # Remove duplicates based on tool name
        seen_names = set()
        unique_tools = []
        for tool in all_tools:
            tool_name = tool.get("name") if isinstance(tool, dict) else getattr(tool, "name", None)
            if tool_name and tool_name not in seen_names:
                seen_names.add(tool_name)
                unique_tools.append(tool)
            elif not tool_name:
                # Keep tools without names (shouldn't happen in well-formed
                # input, but we don't want to silently drop them); warn so
                # broken upstream tool registrations are visible.
                logger.warning("tool registered without a name: %r", tool)
                unique_tools.append(tool)

        # Separate A2UI schema context from regular context.
        # The A2UI schema goes into state["ag-ui"]["a2ui_schema"] so agents
        # can read it directly from state (e.g., for the generate_a2ui tool),
        # instead of it being dumped into the system prompt with all other context.
        A2UI_SCHEMA_CONTEXT_DESCRIPTION = "A2UI Component Schema \u2014 available components for generating UI surfaces. Use these component names and props when creating A2UI operations."

        all_context = input.context or []
        a2ui_schema_value = None
        regular_context = []
        for entry in all_context:
            desc = entry.get("description", "") if isinstance(entry, dict) else getattr(entry, "description", "")
            if desc == A2UI_SCHEMA_CONTEXT_DESCRIPTION:
                a2ui_schema_value = entry.get("value", "") if isinstance(entry, dict) else getattr(entry, "value", "")
            else:
                regular_context.append(entry)

        ag_ui_state: dict = {
            "tools": unique_tools,
            "context": regular_context,
        }
        if a2ui_schema_value is not None:
            ag_ui_state["a2ui_schema"] = a2ui_schema_value

        return {
            **state,
            "messages": new_messages,
            "tools": unique_tools,
            "ag-ui": ag_ui_state,
            "copilotkit": {
                **state.get("copilotkit", {}),
                "actions": unique_tools,
            },
        }

    _ORPHAN_TOOL_MSG_RE = re.compile(
        r"^Tool call '.+' with id '.+' was interrupted before completion\.$"
    )

    def _filter_orphan_tool_messages(self, messages: list) -> list:
        """Remove fake ToolMessages injected by patch_orphan_tool_calls,
        but only between the last user message and the end of the list."""
        # Find the index of the last HumanMessage
        last_human_idx = -1
        for i in range(len(messages) - 1, -1, -1):
            if isinstance(messages[i], HumanMessage):
                last_human_idx = i
                break

        if last_human_idx == -1:
            return messages

        # Keep everything before the last user message as-is,
        # filter the tail
        head = messages[:last_human_idx + 1]
        tail = [
            m for m in messages[last_human_idx + 1:]
            if not (
                    isinstance(m, ToolMessage)
                    and isinstance(m.content, str)
                    and self._ORPHAN_TOOL_MSG_RE.match(m.content)
            )
        ]
        return head + tail

    def get_state_snapshot(self, state: State) -> State:
        # Invariant: callers always operate within an active run.
        assert self.active_run is not None, "get_state_snapshot called outside an active run"
        schema_keys = self.active_run.get("schema_keys")
        output_keys = schema_keys["output"] if schema_keys else None
        if output_keys:
            state = filter_object_by_schema_keys(state, [*DEFAULT_SCHEMA_KEYS, *output_keys])
        return state

    async def _handle_single_event(self, event: Any, state: State) -> AsyncGenerator[str, None]:
        # Invariant: _handle_single_event is only invoked from the event
        # loop inside _handle_stream_events, where active_run has been
        # initialized for the current run.
        assert self.active_run is not None, "_handle_single_event called outside an active run"
        event_type = event.get("event")
        if event_type == LangGraphEventTypes.OnChatModelStream:
            should_emit_messages = (event.get("metadata") or {}).get("emit-messages", True)
            should_emit_tool_calls = (event.get("metadata") or {}).get("emit-tool-calls", True)

            # Chunks are normally LangChain BaseMessage instances (attribute
            # access), but some upstream paths deliver raw dicts — mirror the
            # dual-path accessors used by the outer loop (~line 305) so either
            # shape works instead of AttributeError-crashing here.
            chunk_raw = event.get("data", {}).get("chunk") or {}
            if isinstance(chunk_raw, dict):
                response_metadata = chunk_raw.get("response_metadata") or {}
                tool_call_chunks_list = chunk_raw.get("tool_call_chunks") or []
            else:
                response_metadata = getattr(chunk_raw, "response_metadata", None) or {}
                tool_call_chunks_list = getattr(chunk_raw, "tool_call_chunks", None) or []

            if response_metadata.get('finish_reason', None):
                return

            current_stream = self.get_message_in_progress(self.active_run["id"])
            has_current_stream = bool(current_stream and current_stream.get("id"))
            tool_call_data = tool_call_chunks_list[0] if tool_call_chunks_list else None
            predict_state_metadata = (event.get("metadata") or {}).get("predict_state", [])
            tool_call_used_to_predict_state = False
            if tool_call_data and tool_call_data.get("name") and predict_state_metadata:
                tool_call_used_to_predict_state = any(
                    (predict_tool.get("tool") if isinstance(predict_tool, dict) else getattr(predict_tool, "tool", None)) == tool_call_data["name"]
                    for predict_tool in predict_state_metadata
                )

            is_tool_call_start_event = not has_current_stream and tool_call_data and tool_call_data.get("name")
            is_tool_call_args_event = has_current_stream and current_stream.get("tool_call_id") and tool_call_data and tool_call_data.get("args")
            is_tool_call_end_event = has_current_stream and current_stream.get("tool_call_id") and not tool_call_data

            if is_tool_call_start_event or is_tool_call_end_event or is_tool_call_args_event:
                self.active_run["has_function_streaming"] = True

            chunk = event["data"]["chunk"]

            reasoning_data = resolve_reasoning_content(chunk) if chunk else None
            encrypted_reasoning_data = resolve_encrypted_reasoning_content(chunk) if chunk else None
            # Use an explicit ``is not None`` check so empty-string deltas
            # (``chunk.content == ""``) still reach resolve_message_content.
            # The prior truthy check ``if chunk and chunk.content`` treated
            # "" the same as None and silently dropped zero-length deltas
            # that some providers emit during tool-call / structured-output
            # transitions.
            message_content = (
                resolve_message_content(chunk.content)
                if chunk is not None and getattr(chunk, "content", None) is not None
                else None
            )
            is_message_content_event = tool_call_data is None and message_content
            is_message_end_event = has_current_stream and not current_stream.get("tool_call_id") and not is_message_content_event

            if reasoning_data:
                for event_str in self.handle_reasoning_event(reasoning_data):
                    yield event_str
                return

            # Handle redacted_thinking blocks (encrypted reasoning content)
            if encrypted_reasoning_data and self.active_run.get('reasoning_process', None) is not None:
                reasoning_message_id = self.active_run["reasoning_process"]["message_id"]
                yield self._dispatch_event(
                    ReasoningEncryptedValueEvent(
                        type=EventType.REASONING_ENCRYPTED_VALUE,
                        subtype="message",
                        entity_id=reasoning_message_id,
                        encrypted_value=encrypted_reasoning_data,
                    )
                )
                return

            if reasoning_data is None and self.active_run.get('reasoning_process', None) is not None:
                reasoning_message_id = self.active_run["reasoning_process"]["message_id"]
                # Emit signature as encrypted value if accumulated during reasoning
                if self.active_run["reasoning_process"].get("signature"):
                    yield self._dispatch_event(
                        ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_message_id,
                            encrypted_value=self.active_run["reasoning_process"]["signature"],
                        )
                    )
                yield self._dispatch_event(
                    ReasoningMessageEndEvent(
                        type=EventType.REASONING_MESSAGE_END,
                        message_id=reasoning_message_id,
                    )
                )
                yield self._dispatch_event(
                    ReasoningEndEvent(
                        type=EventType.REASONING_END,
                        message_id=reasoning_message_id,
                    )
                )
                self.active_run["reasoning_process"] = None

            if tool_call_used_to_predict_state:
                yield self._dispatch_event(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_metadata,
                        raw_event=event
                    )
                )

            if is_tool_call_end_event:
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=current_stream["tool_call_id"], raw_event=event)
                )
                self.messages_in_process[self.active_run["id"]] = None
                return


            if is_message_end_event:
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=current_stream["id"], raw_event=event)
                )
                self.messages_in_process[self.active_run["id"]] = None
                return

            if is_tool_call_start_event and should_emit_tool_calls:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call_data["id"],
                        tool_call_name=tool_call_data["name"],
                        parent_message_id=event["data"]["chunk"].id,
                        raw_event=event,
                    )
                )
                self.set_message_in_progress(
                    self.active_run["id"],
                    MessageInProgress(id=event["data"]["chunk"].id, tool_call_id=tool_call_data["id"], tool_call_name=tool_call_data["name"])
                )
                return

            if is_tool_call_args_event and should_emit_tool_calls:
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=current_stream["tool_call_id"],
                        delta=tool_call_data["args"],
                        raw_event=event
                    )
                )
                return

            if is_message_content_event and should_emit_messages:
                if bool(current_stream and current_stream.get("id")) == False:
                    yield self._dispatch_event(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            role="assistant",
                            message_id=event["data"]["chunk"].id,
                            raw_event=event,
                        )
                    )
                    self.set_message_in_progress(
                        self.active_run["id"],
                        MessageInProgress(
                            id=event["data"]["chunk"].id,
                            tool_call_id=None,
                            tool_call_name=None
                        )
                    )
                    current_stream = self.get_message_in_progress(self.active_run["id"])

                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=current_stream["id"],
                        delta=message_content,
                        raw_event=event,
                    )
                )
                return

        elif event_type == LangGraphEventTypes.OnChatModelEnd:
            output_msg = event.get("data", {}).get("output")
            if isinstance(output_msg, BaseMessage):
                self.active_run.setdefault("streamed_messages", []).append(output_msg)
            else:
                # Non-BaseMessage outputs (None / dicts / bespoke return types)
                # can't be merged into the streamed_messages buffer. Log for
                # observability — callers running in debug can see drops.
                logger.debug(
                    "OnChatModelEnd output not appended to streamed_messages (type=%r)",
                    type(output_msg).__name__,
                )
            if self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("tool_call_id"):
                resolved = self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=self.get_message_in_progress(self.active_run["id"])["tool_call_id"], raw_event=event)
                )
                if resolved:
                    self.messages_in_process[self.active_run["id"]] = None
                yield resolved
            elif self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("id"):
                resolved = self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=self.get_message_in_progress(self.active_run["id"])["id"], raw_event=event)
                )
                if resolved:
                    self.messages_in_process[self.active_run["id"]] = None
                yield resolved

        elif event_type == LangGraphEventTypes.OnCustomEvent:
            if event["name"] == CustomEventNames.ManuallyEmitMessage:
                yield self._dispatch_event(
                    TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, role="assistant", message_id=event["data"]["message_id"], raw_event=event)
                )
                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=event["data"]["message_id"],
                        delta=event["data"]["message"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=event["data"]["message_id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitToolCall:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=event["data"]["id"],
                        tool_call_name=event["data"]["name"],
                        parent_message_id=event["data"]["id"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=event["data"]["id"],
                        delta=event["data"]["args"] if isinstance(event["data"]["args"], str) else json.dumps(
                            event["data"]["args"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=event["data"]["id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitState:
                self.active_run["manually_emitted_state"] = event["data"]
                yield self._dispatch_event(
                    StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(self.active_run["manually_emitted_state"]), raw_event=event)
                )
            
            yield self._dispatch_event(
                CustomEvent(type=EventType.CUSTOM, name=event["name"], value=event["data"], raw_event=event)
            )

        elif event_type == LangGraphEventTypes.OnToolEnd:
            tool_call_output = event["data"]["output"]

            if isinstance(tool_call_output, Command):
                # Extract ToolMessages from Command.update. ``.update`` is
                # typed as Optional[Any] upstream — it can be None, a dict,
                # or a list of tuples. Guard for the non-dict shapes instead
                # of crashing with AttributeError on ``.get``.
                update = tool_call_output.update
                if isinstance(update, dict):
                    messages = update.get('messages', []) or []
                else:
                    messages = []

                # Filter explicitly so non-ToolMessage entries (e.g. plain
                # BaseMessage / AIMessage items sometimes attached to Command
                # updates) are logged and dropped rather than silently sliced.
                tool_messages: List[ToolMessage] = []
                for m in messages:
                    if isinstance(m, ToolMessage):
                        tool_messages.append(m)
                    else:
                        logger.debug(
                            "dropping non-ToolMessage entry from Command.update messages: %r",
                            type(m).__name__,
                        )

                # Process each tool message
                for tool_msg in tool_messages:
                    if not self.active_run["has_function_streaming"]:
                        yield self._dispatch_event(
                            ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_msg.tool_call_id,
                                tool_call_name=tool_msg.name or event.get("name", ""),
                                parent_message_id=tool_msg.id,
                                raw_event=event,
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_msg.tool_call_id,
                                delta=json.dumps(event["data"].get("input", {})),
                                raw_event=event
                            )
                        )
                        yield self._dispatch_event(
                            ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_msg.tool_call_id,
                                raw_event=event
                            )
                        )

                    yield self._dispatch_event(
                        ToolCallResultEvent(
                            type=EventType.TOOL_CALL_RESULT,
                            tool_call_id=tool_msg.tool_call_id,
                            message_id=str(uuid.uuid4()),
                            content=normalize_tool_content(tool_msg.content),
                            role="tool"
                        )
                    )
                self.active_run["model_made_tool_call"] = False
                self.active_run["state_reliable"] = True
                self.active_run["has_function_streaming"] = False
                return

            # The non-Command branch below assumes tool_call_output is a
            # ToolMessage (reads .tool_call_id, .name, .id, .content). If an
            # integration delivers something else, log and skip rather than
            # AttributeError-crashing the whole stream.
            if not isinstance(tool_call_output, ToolMessage):
                logger.debug(
                    "OnToolEnd received non-ToolMessage output (%r); skipping dispatch",
                    type(tool_call_output).__name__,
                )
                return

            if not self.active_run["has_function_streaming"]:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call_output.tool_call_id,
                        tool_call_name=tool_call_output.name or event.get("name", ""),
                        parent_message_id=tool_call_output.id,
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool_call_output.tool_call_id,
                        delta=dump_json_safe(event["data"]["input"]),
                        raw_event=event
                    )
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(
                        type=EventType.TOOL_CALL_END,
                        tool_call_id=tool_call_output.tool_call_id,
                        raw_event=event
                    )
                )

            yield self._dispatch_event(
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=tool_call_output.tool_call_id,
                    message_id=str(uuid.uuid4()),
                    content=normalize_tool_content(tool_call_output.content),
                    role="tool"
                )
            )

            self.active_run["model_made_tool_call"] = False
            self.active_run["state_reliable"] = True
            self.active_run["has_function_streaming"] = False

        elif event_type == LangGraphEventTypes.OnToolError:
            # A tool threw before OnToolEnd could fire. Reset the suppression
            # flags so subsequent snapshots are not permanently blocked.
            logger.debug(
                "on_tool_error received — clearing model_made_tool_call/state_reliable (tool=%s)",
                event.get("name"),
            )
            self.active_run["model_made_tool_call"] = False
            self.active_run["state_reliable"] = True
            self.active_run["has_function_streaming"] = False

    def handle_reasoning_event(self, reasoning_data: LangGraphReasoning) -> Generator[ProcessedEvents, Any, str | None]:
        # Invariant: reasoning events are dispatched from _handle_single_event,
        # which itself runs inside an active run.
        assert self.active_run is not None, "handle_reasoning_event called outside an active run"
        if not reasoning_data or "type" not in reasoning_data or "text" not in reasoning_data:
            return ""

        reasoning_step_index = reasoning_data["index"]

        if (self.active_run.get("reasoning_process") and
                self.active_run["reasoning_process"].get("index") and
                self.active_run["reasoning_process"]["index"] != reasoning_step_index):

            reasoning_message_id = self.active_run["reasoning_process"]["message_id"]
            if self.active_run["reasoning_process"].get("type"):
                yield self._dispatch_event(
                    ReasoningMessageEndEvent(
                        type=EventType.REASONING_MESSAGE_END,
                        message_id=reasoning_message_id,
                    )
                )
            yield self._dispatch_event(
                ReasoningEndEvent(
                    type=EventType.REASONING_END,
                    message_id=reasoning_message_id,
                )
            )
            self.active_run["reasoning_process"] = None

        if not self.active_run.get("reasoning_process"):
            message_id = str(uuid.uuid4())
            yield self._dispatch_event(
                ReasoningStartEvent(
                    type=EventType.REASONING_START,
                    message_id=message_id,
                )
            )
            self.active_run["reasoning_process"] = {
                "index": reasoning_step_index,
                "message_id": message_id,
            }

        if self.active_run["reasoning_process"].get("type") != reasoning_data["type"]:
            yield self._dispatch_event(
                ReasoningMessageStartEvent(
                    type=EventType.REASONING_MESSAGE_START,
                    message_id=self.active_run["reasoning_process"]["message_id"],
                    role="reasoning",
                )
            )
            self.active_run["reasoning_process"]["type"] = reasoning_data["type"]

        # Accumulate signature if present (Anthropic extended thinking)
        if reasoning_data.get("signature"):
            self.active_run["reasoning_process"]["signature"] = reasoning_data["signature"]

        if self.active_run["reasoning_process"].get("type"):
            yield self._dispatch_event(
                ReasoningMessageContentEvent(
                    type=EventType.REASONING_MESSAGE_CONTENT,
                    message_id=self.active_run["reasoning_process"]["message_id"],
                    delta=reasoning_data["text"]
                )
            )

    async def get_checkpoint_before_message(self, message_id: str, thread_id: str, config: Optional[RunnableConfig] = None) -> Any:
        if not thread_id:
            raise ValueError("Missing thread_id in config")

        # ``aget_state_history`` needs a RunnableConfig with ``configurable.thread_id``.
        # Prefer the caller's config when provided so any downstream configurable keys
        # (graph subkey, etc.) are preserved; otherwise fall back to a thread-only
        # config derived from ``thread_id``.
        #
        # Strip ``checkpoint_id`` and ``checkpoint_ns`` from the caller's configurable:
        # if they survive into history_config, ``aget_state_history`` filters to the
        # single pinned checkpoint and the linear walk that looks up the snapshot
        # containing ``message_id`` always misses.
        history_config: RunnableConfig
        if config is not None:
            caller_configurable = {
                k: v
                for k, v in (config.get("configurable") or {}).items()
                if k not in ("checkpoint_id", "checkpoint_ns")
            }
            history_config = {
                **config,
                "configurable": {
                    **caller_configurable,
                    "thread_id": thread_id,
                },
            }
        else:
            history_config = {"configurable": {"thread_id": thread_id}}

        history_list = []
        async for snapshot in self.graph.aget_state_history(history_config):
            history_list.append(snapshot)

        history_list.reverse()
        for idx, snapshot in enumerate(history_list):
            messages = snapshot.values.get("messages", [])
            if any(getattr(m, "id", None) == message_id for m in messages):
                if idx == 0:
                    # No snapshot before this
                    # Return synthetic "empty before" version
                    empty_snapshot = snapshot
                    empty_snapshot.values["messages"] = []
                    return empty_snapshot

                snapshot_values_without_messages = snapshot.values.copy()
                del snapshot_values_without_messages["messages"]
                checkpoint = history_list[idx - 1]

                merged_values = {**checkpoint.values, **snapshot_values_without_messages}
                checkpoint = checkpoint._replace(values=merged_values)

                return checkpoint

        raise ValueError(
            f"Message ID {message_id!r} not found in history "
            f"(thread_id={thread_id!r}, snapshots_scanned={len(history_list)})"
        )

    def handle_node_change(self, node_name: Optional[str]) -> Generator[ProcessedEvents, None, None]:
        """
        Centralized method to handle node name changes and step transitions.
        Automatically manages step start/end events based on node name changes.
        """
        # Invariant: node-change handling only happens mid-run.
        assert self.active_run is not None, "handle_node_change called outside an active run"

        if node_name == "__end__":
            node_name = None

        if node_name != self.active_run.get("node_name"):
            # End current step if we have one
            if self.active_run.get("node_name"):
                yield self.end_step()

            # Start new step if we have a node name
            if node_name:
                for event in self.start_step(node_name):
                    yield event

        self.active_run["node_name"] = node_name

    def start_step(self, step_name: str) -> Generator[ProcessedEvents, None, None]:
        """Emit STEP_STARTED for ``step_name``; node_name bookkeeping is done by handle_node_change."""
        yield self._dispatch_event(
            StepStartedEvent(
                type=EventType.STEP_STARTED,
                step_name=step_name
            )
        )

    def end_step(self) -> ProcessedEvents:
        """Emit STEP_FINISHED for the active step; node_name bookkeeping is done by handle_node_change."""
        # Invariant: end_step is only called mid-run, from handle_node_change.
        assert self.active_run is not None, "end_step called outside an active run"
        node_name = self.active_run.get("node_name")
        if not node_name:
            raise ValueError("No active step to end")

        return self._dispatch_event(
            StepFinishedEvent(
                type=EventType.STEP_FINISHED,
                step_name=node_name
            )
        )

    # Probe the graph's astream_events signature for version-specific support
    # (notably the ``context`` parameter, added in newer LangGraph releases)
    # so this adapter remains backwards-compatible across LangGraph versions.
    def get_stream_kwargs(
            self,
            input: Any,
            subgraphs: bool = False,
            version: Literal["v1", "v2"] = "v2",
            config: Optional[RunnableConfig] = None,
            context: Optional[Dict[str, Any]] = None,
            fork: Optional[Any] = None,
    ) -> Dict[str, Any]:
        kwargs = dict(
            input=input,
            subgraphs=subgraphs,
            version=version,
        )

        # Only add context if supported
        sig = inspect.signature(self.graph.astream_events)
        if 'context' in sig.parameters:
            base_context = {}
            if isinstance(config, dict) and 'configurable' in config and isinstance(config['configurable'], dict):
                base_context.update(config['configurable'])
            if context:  # context might be None or {}
                base_context.update(context)
            if base_context:  # only add if there's something to pass
                kwargs['context'] = base_context

        if config:
            kwargs['config'] = config

        if fork:
            kwargs.update(fork)

        return kwargs

    async def get_state_and_messages_snapshots(self, config: RunnableConfig, merge_streamed_messages: bool = True) -> AsyncGenerator[ProcessedEvents, None]:
        """Emit STATE_SNAPSHOT + MESSAGES_SNAPSHOT for the current checkpoint.

        ``merge_streamed_messages`` controls whether uncommitted messages
        accumulated in ``active_run["streamed_messages"]`` are appended to
        the checkpoint's message list before emitting MESSAGES_SNAPSHOT.

        Mid-stream callers (subgraph-boundary transitions) pass ``True``
        (the default) so in-flight subgraph messages surface before their
        parent graph commits them to checkpoint state — otherwise clients
        see a lag where assistant output streams from an inner subgraph
        but the outer snapshot hasn't yet merged those messages.

        The post-run caller passes ``True`` only when at least one
        mid-stream merge already fired (``any_mid_stream_merge_fired``),
        i.e. a subgraph handoff delivered ``streamed_messages`` to the
        client that the parent graph never committed to state; the final
        snapshot must preserve them. Otherwise the post-run caller
        passes ``False`` so the final snapshot is emitted from the
        checkpoint alone — dropping transient/intermediate LLM outputs
        (e.g. ``.with_structured_output()`` / router / classifier calls)
        that never committed and would otherwise appear as duplicate /
        empty assistant bubbles.
        """
        # Invariant: snapshot emission only happens mid-run.
        assert self.active_run is not None, "get_state_and_messages_snapshots called outside an active run"
        state = await self.graph.aget_state(config)
        state_values = state.values if state.values is not None else state
        yield self._dispatch_event(
            StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(state_values))
        )

        checkpoint_messages = state_values.get("messages", [])
        if merge_streamed_messages:
            streamed_messages = self.active_run.get("streamed_messages", [])
            if streamed_messages:
                checkpoint_ids = {getattr(m, "id", None) for m in checkpoint_messages} - {None}
                extra = []
                for m in streamed_messages:
                    mid = getattr(m, "id", None)
                    if not mid:
                        # Streamed messages without an id cannot be deduplicated
                        # against the checkpoint and would merge as duplicates;
                        # log so the drop is observable in debug builds.
                        logger.debug(
                            "dropping streamed message without id: %r", type(m).__name__,
                        )
                        continue
                    if mid not in checkpoint_ids:
                        extra.append(m)
                checkpoint_messages = checkpoint_messages + extra
        snapshot_messages = self._filter_orphan_tool_messages(checkpoint_messages)
        yield self._dispatch_event(
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=langchain_messages_to_agui(snapshot_messages),
            )
        )


def dump_json_safe(value):
    # Sharp edge: when ``value`` is already a ``str`` it is returned verbatim
    # (not re-encoded with json.dumps). Callers passing pre-serialized JSON
    # strings get them back as-is; callers passing a raw non-JSON string get
    # that raw string back — no quoting is applied.
    return json.dumps(value, default=json_safe_stringify) if not isinstance(value, str) else value
