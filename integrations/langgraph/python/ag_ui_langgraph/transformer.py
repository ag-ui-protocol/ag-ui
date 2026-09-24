"""AG-UI ``StreamTransformer`` for LangGraph's v3 streaming protocol.

Wired into a graph at compile time via ``graph.compile(transformers=[agui_transformer])``.
Exposes a named ``agui`` channel reached by SDK clients via the run stream's
extensions. Translates langgraph ``ProtocolEvent``s into AG-UI events across
every family: lifecycle (``STEP_*``, terminal ``RUN_ERROR``), messages
(``TEXT_*``, ``TOOL_CALL_*``, ``REASONING_*``), tool results
(``TOOL_CALL_RESULT``), state (``STATE_SNAPSHOT`` / ``MESSAGES_SNAPSHOT``),
tasks (``CUSTOM`` ``OnInterrupt``), and custom (``ManuallyEmit*`` + generic
passthrough).

``RUN_STARTED`` / ``RUN_FINISHED`` are owned by the agent, not by this
transformer; it pushes everything in between.

This is the Python port of ``integrations/langgraph/typescript/src/transformer/
agui-transformer.ts``. The v3 streaming API (``langgraph.stream``) only exists
in langgraph >= 1.2, while this package's floor is ``langgraph>=0.6.0,<2``, so
``langgraph.stream`` is imported lazily inside :func:`agui_transformer`. Merely
importing ``ag_ui_langgraph`` keeps working on older langgraph.
"""

from __future__ import annotations

import json
from typing import Any, Dict, Optional, Sequence, Set, Tuple

from ag_ui.core import (
    CustomEvent,
    EventType,
    MessagesSnapshotEvent,
    ReasoningEncryptedValueEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunErrorEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from .types import CustomEventNames, LangGraphEventTypes, State
from .utils import (
    json_safe_stringify,
    langchain_messages_to_agui,
    normalize_tool_content,
)

__all__ = ["agui_transformer", "AGUI_CHANNEL_NAME", "MIN_LANGGRAPH_ERROR"]

# Name of the remotely-consumable channel the transformer projects. The mux
# auto-forwards every ``push()`` on a *named* channel into the main protocol
# event log, which is the Python equivalent of TS ``StreamChannel.remote()``.
AGUI_CHANNEL_NAME = "agui"

MIN_LANGGRAPH_ERROR = (
    "The AG-UI stream transformer requires langgraph >= 1.2 "
    "(langgraph.stream is unavailable in the installed version). "
    "Upgrade langgraph, or keep using LangGraphAgent's v2 event translation."
)


def _stringify(value: Any) -> str:
    """JSON-encode a value for an AG-UI ``CUSTOM`` payload.

    Mirrors the TS ``JSON.stringify(payload ?? null)`` coercion: a missing
    payload must become the *string* ``"null"``, never ``None``, because AG-UI
    ``CUSTOM`` requires a string value for interrupt payloads.
    """
    if isinstance(value, str):
        return value
    return json.dumps(value if value is not None else None, default=json_safe_stringify)


def _hash(value: Any) -> str:
    """Stable structural digest used for snapshot dedup.

    ``sort_keys`` keeps the digest independent of dict ordering, so a state
    rebuilt with the same values in a different key order is still recognised
    as unchanged.
    """
    return json.dumps(value, sort_keys=True, default=json_safe_stringify)


def _common_prefix_len(a: str, b: str) -> int:
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i] == b[i]:
        i += 1
    return i


class _ToolBlock:
    """Per-content-block bookkeeping for one streaming tool call.

    ``args_so_far`` carries the cumulative ``args`` string the engine has
    reported. ``block-delta`` carries the FULL accumulated value each time,
    not an incremental piece, so we diff against this to derive the delta AG-UI
    expects. ``started`` tracks whether ``TOOL_CALL_START`` has gone out: when a
    tool block opens without a name (the name only arrives on a later
    ``block-delta``) the START is deferred so it never ships a knowingly empty
    ``tool_call_name``, and ``args_so_far`` is buffered until it can be flushed.
    """

    __slots__ = ("tool_call_id", "tool_call_name", "args_so_far", "started", "parent_message_id")

    def __init__(
        self,
        tool_call_id: str,
        tool_call_name: str,
        args_so_far: str,
        parent_message_id: Optional[str],
    ) -> None:
        self.tool_call_id = tool_call_id
        self.tool_call_name = tool_call_name
        self.args_so_far = args_so_far
        self.started = False
        self.parent_message_id = parent_message_id


class _ReasoningBlock:
    __slots__ = ("message_id", "message_started")

    def __init__(self, message_id: str) -> None:
        self.message_id = message_id
        self.message_started = False


def _build_transformer_class(stream_transformer_base: Any, stream_channel_cls: Any) -> Any:
    """Build the ``AGUIStreamTransformer`` subclass.

    The base class only exists on langgraph >= 1.2, so the subclass is created
    once, on first use, from the lazily imported symbols and then cached on the
    module.
    """

    class AGUIStreamTransformer(stream_transformer_base):  # type: ignore[misc, valid-type]
        """Projects langgraph v3 protocol events onto an AG-UI ``agui`` channel."""

        # Everything the translation reads. `tools` carries ToolNode results,
        # `tasks` carries interrupts (and drives the built-in lifecycle).
        required_stream_modes = ("values", "messages", "custom", "tasks", "tools")

        def __init__(self, scope: Tuple[str, ...] = ()) -> None:
            super().__init__(scope)
            self._channel = stream_channel_cls(AGUI_CHANNEL_NAME)
            self._initialized = False
            self._transport_started = False
            # Set once a terminal RUN_ERROR has been pushed (root `failed`
            # lifecycle). AG-UI grammar forbids ANY event after RUN_ERROR, so
            # every subsequent push -- including finalize()'s block/step
            # closes -- is suppressed once this flips.
            self._run_errored = False

            # Per-message tracking for text streaming, keyed by content-block
            # index so multi-block messages (e.g. text + tool call in one
            # assistant turn) don't collide on a single shared id.
            self._text_block_message_ids: Dict[int, str] = {}
            self._tool_blocks: Dict[int, _ToolBlock] = {}
            self._reasoning_blocks: Dict[int, _ReasoningBlock] = {}
            self._active_message_id: Optional[str] = None
            # Whether the bare `active_message_id` has already been handed to a
            # text content-block in the current message. The first text block
            # keeps the bare id so the streamed message reconciles with the
            # MESSAGES_SNAPSHOT copy emitted under the same id; any additional
            # text blocks in the same message get a distinct suffixed id so we
            # never emit two TEXT_MESSAGE_START for one id.
            self._bare_text_id_assigned = False

            # Per-run set of interrupt ids already converted into CUSTOM
            # `OnInterrupt` pushes. The same interrupt can be re-broadcast
            # (input + result frames); dedup so the client renders one prompt.
            self._emitted_interrupt_ids: Set[str] = set()

            # Active graph-node steps keyed by full namespace path -> step name.
            # The companion `_active_step_names` enforces AG-UI's
            # name-uniqueness contract: at most one STEP_STARTED per step name
            # at a time. Inner subgraph nodes whose stripped head name collides
            # with an already active step are ignored so the outer
            # STEP_FINISHED stays balanced.
            self._active_steps: Dict[str, str] = {}
            self._active_step_names: Set[str] = set()
            self._root_tasks: Dict[str, str] = {}
            self._root_task_inputs: Dict[str, State] = {}
            self._pending_step_finishes: list[str] = []
            self._seen_root_tasks: Set[str] = set()
            self._tasks_own_steps = False
            self._model_made_tool_call = False
            self._streamed_tool_call_ids: Set[str] = set()
            self._predict_state: list = []
            self._pending_interrupts: list = []

            # Snapshot emission is deferred to stable points (node/subgraph
            # boundaries, root completion/interrupt). Every Pregel step emits
            # its own `values` event; pushing a MESSAGES_SNAPSHOT for each one
            # would ship the in-between dip where an assistant message has
            # temporarily lost its tool calls.
            self._latest_state: Optional[State] = None
            self._last_messages_snapshot_hash = ""
            self._last_state_snapshot_hash = ""
            # Reasoning ids already surfaced from message additional_kwargs, so
            # repeated flushes don't re-emit the same reasoning summary.
            self._emitted_reasoning_ids: Set[str] = set()
            # Set when a `messages`-channel reasoning content block streamed.
            # When reasoning already streamed we must NOT also surface it from
            # additional_kwargs, or the same summary would render twice.
            self._saw_streaming_reasoning = False

        # ------------------------------------------------------------------
        # StreamTransformer hooks
        # ------------------------------------------------------------------

        def init(self) -> Dict[str, Any]:
            self._initialized = True
            return {AGUI_CHANNEL_NAME: self._channel}

        def _transport_status(self, status: str) -> None:
            # Internal same-channel barrier; the adapter consumes it before
            # AG-UI dispatch. Root interrupted may precede final snapshots.
            self._channel.push({"type": "CUSTOM", "name": "__ag_ui_transformer_status__", "value": status})

        def finalize(self) -> None:
            # A root `failed` already closed blocks/steps and emitted the
            # terminal RUN_ERROR; nothing may follow it, so skip entirely.
            if self._run_errored:
                self._transport_status("finished")
                return
            # In the TS port the ROOT `lifecycle` `completed` frame is what
            # flushes the final snapshot pair. Python langgraph never delivers a
            # root lifecycle frame to a transformer (see `_on_tasks`), and the
            # last root `values` event lands after the last task result, so the
            # run-terminal flush belongs here, after balancing open blocks.
            # Lifecycle (RUN_*) is owned by the agent. Here we only close any
            # text/tool/reasoning blocks and steps that didn't receive their
            # close before the run ended, so AG-UI verification doesn't reject
            # the terminal event downstream.
            self._close_open_message_blocks()
            if self._latest_state is not None and not self._model_made_tool_call:
                self._emit_state_snapshot(self._latest_state)
            self._flush_step_finishes()
            self._close_open_steps()
            self._flush_snapshots()
            for payload in self._pending_interrupts:
                self._push_interrupt(payload)
            self._pending_interrupts.clear()
            self._transport_status("finished")

        def fail(self, err: BaseException) -> None:
            # A run that dies with a raw exception (no root `failed` lifecycle
            # frame) still has to leave a balanced stream, so close whatever is
            # open. The terminal error event itself is NOT pushed here: a root
            # `failed` frame already emitted RUN_ERROR and latched (so this
            # returns early), and when there was no such frame the agent owns
            # the terminal event -- pushing a second one would break the
            # grammar downstream.
            if not self._run_errored:
                self._close_open_message_blocks()
                self._close_open_steps()
            self._transport_status("finished")

        def process(self, event: Any) -> bool:
            # The mux wires the channel only after init() returns. Pushes
            # before then are dropped on the wire, so skip until init has run.
            if not self._initialized:
                return True

            if not self._transport_started:
                self._transport_started = True
                self._transport_status("started")
            method = event.get("method")
            params = event.get("params") or {}

            if method == "lifecycle":
                self._on_lifecycle(params)
            elif method == "input.requested":
                self._on_input_requested(params)
            elif method == "messages":
                self._on_messages(params)
            elif method == "values":
                if _is_root_namespace(params.get("namespace") or []):
                    self._cache_state(params.get("data"))
            elif method == "tasks":
                self._on_tasks(params)
            elif method == "tools":
                self._on_tools(params)
            elif method == "custom":
                self._on_custom(params)
            # checkpoints, updates, input -- not translated. Drop through.
            return True

        # ------------------------------------------------------------------
        # Push plumbing
        # ------------------------------------------------------------------

        def _push(self, ev: Any) -> None:
            # Nothing may follow a terminal RUN_ERROR. Drop late pushes so a
            # block/step close (or any stray trailing event) can never trail it.
            if self._run_errored:
                return
            # Platform forwards channel values verbatim. Serialize the AG-UI
            # envelope here so remote clients receive messageId/stepName, not
            # Pydantic's Python attribute names. Keep nulls inside user payloads.
            wire = ev.model_dump(mode="json", by_alias=True, exclude_none=True)
            # State and custom payloads are application data, where null is a
            # meaningful value. Optional AG-UI envelope fields are omitted.
            if isinstance(ev, (StateSnapshotEvent, CustomEvent)):
                full = ev.model_dump(mode="json", by_alias=True)
                key = "snapshot" if isinstance(ev, StateSnapshotEvent) else "value"
                wire[key] = full[key]
            self._channel.push(wire)

        # ------------------------------------------------------------------
        # Block bookkeeping
        # ------------------------------------------------------------------

        def _allocate_text_message_id(self, index: int) -> str:
            """Allocate the message id for a text content-block.

            The first text block of a message keeps the bare message id so it
            reconciles with the MESSAGES_SNAPSHOT copy; later blocks get a
            distinct suffixed id.
            """
            if not self._bare_text_id_assigned:
                self._bare_text_id_assigned = True
                return str(self._active_message_id)
            return f"{self._active_message_id}:t:{index}"

        def _ensure_tool_started(self, tool: _ToolBlock) -> None:
            """Emit TOOL_CALL_START for a deferred tool block exactly once,
            flushing any args buffered while we waited for the name.

            Idempotent: safe to call from both the name-arrival path and every
            close path, so a tool that never got a name still produces a
            balanced START/END pair.
            """
            if tool.started:
                return
            tool.started = True
            self._streamed_tool_call_ids.add(tool.tool_call_id)
            if any(item.get("tool") == tool.tool_call_name for item in self._predict_state):
                self._model_made_tool_call = True
                self._push(CustomEvent(type=EventType.CUSTOM, name="PredictState", value=self._predict_state))
            self._push(
                ToolCallStartEvent(
                    type=EventType.TOOL_CALL_START,
                    tool_call_id=tool.tool_call_id,
                    tool_call_name=tool.tool_call_name,
                    parent_message_id=tool.parent_message_id,
                )
            )
            if tool.args_so_far:
                self._push(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool.tool_call_id,
                        delta=tool.args_so_far,
                    )
                )

        def _close_open_message_blocks(self) -> None:
            """Close every open message-scoped block (text / tool / reasoning),
            emitting the matching END events so the stream stays balanced.

            Shared by finalize() (run end), message-finish, and message-error so
            none of them can leave a dangling START. Steps are run-scoped, not
            message-scoped, so they are NOT closed here.
            """
            for message_id in list(self._text_block_message_ids.values()):
                self._push(TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id))
            self._text_block_message_ids.clear()

            for tool in list(self._tool_blocks.values()):
                self._ensure_tool_started(tool)
                self._push(ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool.tool_call_id))
            self._tool_blocks.clear()

            for block in list(self._reasoning_blocks.values()):
                if block.message_started:
                    self._push(
                        ReasoningMessageEndEvent(
                            type=EventType.REASONING_MESSAGE_END, message_id=block.message_id
                        )
                    )
                self._push(ReasoningEndEvent(type=EventType.REASONING_END, message_id=block.message_id))
            self._reasoning_blocks.clear()

        def _close_open_steps(self) -> None:
            """Close every run-scoped step still open, emitting the matching
            STEP_FINISHED. Shared by finalize() (run end) and the root `failed`
            path so a run that errors mid-step stays balanced with the close
            preceding the terminal RUN_ERROR."""
            self._flush_step_finishes()
            for step_name in dict.fromkeys([*self._active_steps.values(), *self._root_tasks.values()]):
                self._push(StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=step_name))
            self._root_tasks.clear()
            self._active_steps.clear()
            self._active_step_names.clear()

        # ------------------------------------------------------------------
        # Snapshots
        # ------------------------------------------------------------------

        def _cache_state(self, state: Any) -> None:
            if not isinstance(state, dict):
                return
            # Shallow-merge instead of replace. Subsequent root `values` events
            # may carry only the keys that just changed (e.g. an interrupt
            # update without `messages` rebroadcast); replacing wholesale would
            # drop the unchanged keys and ship an empty MESSAGES_SNAPSHOT,
            # which CopilotKit treats as "no messages" and resets the UI.
            merged: Dict[str, Any] = dict(self._latest_state or {})
            merged.update(state)
            self._latest_state = merged

        def _emit_message_reasoning(self, messages: Sequence[Any]) -> None:
            """Surface OpenAI Responses reasoning carried on an assistant
            message's ``additional_kwargs.reasoning`` (``{id, summary: [{text}]}``).

            That reasoning never arrives as a ``messages``-channel content
            block, so the streaming path above never sees it; emit it once the
            full message is known.
            """
            if self._saw_streaming_reasoning:
                return
            for msg in messages or []:
                additional_kwargs = _get(msg, "additional_kwargs") or {}
                if not isinstance(additional_kwargs, dict):
                    continue
                reasoning = additional_kwargs.get("reasoning")
                if not isinstance(reasoning, dict):
                    continue
                block_id = reasoning.get("id")
                if not block_id or str(block_id) in self._emitted_reasoning_ids:
                    continue
                summary = reasoning.get("summary")
                if not isinstance(summary, list) or not summary:
                    continue
                text = "".join(
                    part.get("text", "")
                    for part in summary
                    if isinstance(part, dict) and isinstance(part.get("text"), str)
                )
                if not text:
                    continue
                message_id = str(block_id)
                self._emitted_reasoning_ids.add(message_id)
                self._push(ReasoningStartEvent(type=EventType.REASONING_START, message_id=message_id))
                self._push(
                    ReasoningMessageStartEvent(
                        type=EventType.REASONING_MESSAGE_START, message_id=message_id, role="reasoning"
                    )
                )
                self._push(
                    ReasoningMessageContentEvent(
                        type=EventType.REASONING_MESSAGE_CONTENT, message_id=message_id, delta=text
                    )
                )
                self._push(
                    ReasoningMessageEndEvent(type=EventType.REASONING_MESSAGE_END, message_id=message_id)
                )
                self._push(ReasoningEndEvent(type=EventType.REASONING_END, message_id=message_id))

        def _emit_state_snapshot(self, state: State) -> None:
            # Keep messages in state, as the V2 Platform adapter does. JSON
            # serialization captures live BaseMessage fields before middleware
            # can mutate them in a later task.
            snapshot = StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=state)
            value = snapshot.model_dump(mode="json", by_alias=True)["snapshot"]
            for message in value.get("messages", []):
                if not isinstance(message, dict):
                    continue
                metadata = message.get("response_metadata", {})
                content = message.get("content")
                # V3 puts tool calls in content as well as tool_calls. V2
                # keeps them only in tool_calls, including while middleware
                # temporarily intercepts a frontend call.
                if message.get("type") == "ai" and isinstance(content, list):
                    call_ids = {_get(call, "id") for call in message.get("tool_calls", [])
                                if isinstance(_get(call, "id"), str) and _get(call, "id")}
                    content = [block for block in content if not (
                        isinstance(block, dict) and block.get("type") == "tool_call"
                        and block.get("id") in (call_ids | self._streamed_tool_call_ids))]
                    if not content:
                        message["content"] = ""
                # Preserve V2 text without dropping rich content.
                if (message.get("type") == "ai" and metadata.get("model_provider") == "openai"
                    and isinstance(content, list) and all(
                        isinstance(block, dict) and block.get("type") == "text"
                        and isinstance(block.get("text"), str)
                        and set(block) <= {"type", "text", "index"} for block in content)):
                    message["content"] = "".join(block["text"] for block in content)
                    message["response_metadata"] = {key: item for key, item in metadata.items() if key != "output_version"}
            state_hash = _hash(value)
            if state_hash != self._last_state_snapshot_hash:
                self._last_state_snapshot_hash = state_hash
                self._push(StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=value))

        def _flush_snapshots(self) -> None:
            if self._latest_state is None:
                return
            state = self._latest_state

            self._emit_state_snapshot(state)

            lc_messages = state.get("messages") or []
            # Surface reasoning summaries carried on message additional_kwargs
            # before the snapshot, so consumers see the REASONING entity for
            # this message.
            self._emit_message_reasoning(lc_messages)
            agui_messages = langchain_messages_to_agui(lc_messages)
            # The Platform V2 converter retains an empty toolCalls array for
            # assistant messages whose LangChain tool_calls field is present.
            by_id = {_get(message, "id"): message for message in lc_messages}
            for message in agui_messages:
                original = by_id.get(message.id)
                if message.role == "assistant":
                    original_calls = _get(original, "tool_calls")
                    if original_calls == []:
                        message.tool_calls = []
                    calls_by_id = {_get(call, "id"): call for call in original_calls or []}
                    for call in message.tool_calls or []:
                        source = calls_by_id.get(call.id)
                        if source is not None:
                            call.function.arguments = json.dumps(_get(source, "args"), ensure_ascii=False, separators=(",", ":"))
            msg_hash = _hash([_dump(m) for m in agui_messages])
            if msg_hash != self._last_messages_snapshot_hash:
                self._last_messages_snapshot_hash = msg_hash
                self._push(
                    MessagesSnapshotEvent(type=EventType.MESSAGES_SNAPSHOT, messages=agui_messages)
                )

        # ------------------------------------------------------------------
        # lifecycle
        # ------------------------------------------------------------------

        def _on_lifecycle(self, params: Dict[str, Any]) -> None:
            data = params.get("data") or {}
            status = data.get("event") if isinstance(data, dict) else None
            namespace = params.get("namespace") or []

            # Non-root lifecycle events bracket individual graph nodes.
            # Translate them to AG-UI STEP_STARTED / STEP_FINISHED so consumers
            # can show progress on multi-node graphs. The namespace head is
            # `nodeName:uuid` -- strip the uuid for a readable step name.
            if not _is_root_namespace(namespace):
                if self._tasks_own_steps:
                    return
                head = namespace[0]
                ns_key = "|".join(str(part) for part in namespace)
                step_name = head.split(":")[0] if isinstance(head, str) else ""
                if not step_name:
                    return
                if status == "started":
                    if step_name not in self._active_step_names:
                        self._active_step_names.add(step_name)
                        self._active_steps[ns_key] = step_name
                        self._push(StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name))
                elif status in ("completed", "failed", "interrupted"):
                    tracked = self._active_steps.pop(ns_key, None)
                    if tracked is not None:
                        self._active_step_names.discard(tracked)
                        self._push(StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=tracked))
                return

            # Lifecycle bracketing (RUN_STARTED / RUN_FINISHED) is owned by the
            # agent. Here we only forward fatal failures so the client can
            # surface the underlying message instead of a generic
            # INCOMPLETE_STREAM error.
            if status in ("completed", "interrupted"):
                # Stable point: the run is paused (interrupted) or done
                # (completed). HITL graphs land here on every interrupt() call.
                self._close_open_message_blocks()
                self._close_open_steps()
                self._flush_snapshots()
            elif status == "failed":
                message = data.get("error") if isinstance(data, dict) else None
                # Close any open text/tool/reasoning blocks and steps FIRST so
                # their END events precede the terminal RUN_ERROR. AG-UI grammar
                # forbids events after RUN_ERROR.
                self._close_open_message_blocks()
                self._close_open_steps()
                self._push(
                    RunErrorEvent(type=EventType.RUN_ERROR, message=message or "Unknown error")
                )
                # Latch so finalize() and any stray trailing push are suppressed.
                self._run_errored = True

        # ------------------------------------------------------------------
        # input.requested / tasks -> CUSTOM OnInterrupt
        # ------------------------------------------------------------------

        def _on_input_requested(self, params: Dict[str, Any]) -> None:
            data = params.get("data")
            if not isinstance(data, dict):
                return
            # Dedup by interrupt id, mirroring the `tasks` path: the same
            # interrupt can be re-broadcast (input + result frames) and the
            # client should only render one prompt. Frames without an id fall
            # through (can't dedup).
            interrupt_id = data.get("interrupt_id")
            if interrupt_id:
                if interrupt_id in self._emitted_interrupt_ids:
                    return
                self._emitted_interrupt_ids.add(interrupt_id)
            self._push_interrupt(data.get("payload"))

        def _on_tasks(self, params: Dict[str, Any]) -> None:
            data = params.get("data")
            if not isinstance(data, dict):
                return
            self._on_task_step(params, data)
            self._on_task_interrupts(params, data)

        def _flush_step_finishes(self) -> None:
            for name in self._pending_step_finishes:
                self._push(StepFinishedEvent(type=EventType.STEP_FINISHED, step_name=name))
            self._pending_step_finishes.clear()

        def _on_task_step(self, params: Dict[str, Any], data: Dict[str, Any]) -> None:
            """Root tasks own steps and V2 state snapshots.

            Messages snapshots wait for the reduced terminal state, so frontend
            tool interception cannot erase tool linkage in the UI.
            """
            if not _is_root_namespace(params.get("namespace") or []):
                return
            task_id = data.get("id")
            step_name = data.get("name")
            if not task_id:
                return
            if "input" in data and step_name and step_name not in ("__start__", "__end__"):
                if task_id in self._seen_root_tasks:
                    return
                self._flush_step_finishes()
                self._seen_root_tasks.add(task_id)
                self._tasks_own_steps = True
                if step_name not in self._root_tasks.values():
                    self._push(StepStartedEvent(type=EventType.STEP_STARTED, step_name=step_name))
                self._root_tasks[task_id] = step_name
                self._cache_state(data.get("input"))
                if self._latest_state is not None:
                    self._root_task_inputs[task_id] = self._latest_state
                    if not self._model_made_tool_call:
                        self._emit_state_snapshot(self._latest_state)
            elif "result" in data or "error" in data:
                tracked = self._root_tasks.pop(task_id, None)
                if tracked is None:
                    return
                # Middleware can mutate its input in place (including tool
                # interception). Snapshot that input, never a partial result.
                task_input = self._root_task_inputs.pop(task_id, None)
                if task_input is not None and not self._model_made_tool_call:
                    self._emit_state_snapshot(task_input)
                    # A full conversation result is already reduced. A delta
                    # (create_agent's model node) must wait for root values.
                    result = data.get("result")
                    if isinstance(result, (list, tuple)):
                        result = dict(result)
                    if isinstance(result, dict) and isinstance(result.get("messages"), list):
                        old_ids = {_get(m, "id") for m in task_input.get("messages", [])}
                        new_ids = {_get(m, "id") for m in result["messages"]}
                        ids_are_valid = (all(isinstance(id, str) and id for id in old_ids | new_ids)
                            and len(old_ids) == len(task_input.get("messages", []))
                            and len(new_ids) == len(result["messages"]))
                        if not ids_are_valid:
                            result = None
                        elif old_ids < new_ids:
                            self._cache_state(result)
                            self._emit_state_snapshot(self._latest_state)
                        elif old_ids & new_ids and _hash(result["messages"]) != _hash(task_input.get("messages", [])):
                            replacements = {_get(m, "id"): m for m in result["messages"]}
                            updated = {**task_input, **result, "messages": [
                                replacements.get(_get(m, "id"), m) for m in task_input.get("messages", [])]}
                            self._emit_state_snapshot(updated)
                if tracked not in self._root_tasks.values():
                    self._pending_step_finishes.append(tracked)

        def _on_task_interrupts(self, params: Dict[str, Any], data: Dict[str, Any]) -> None:
            # The v3 protocol surfaces interrupt() calls as `tasks` events with
            # an `interrupts: [...]` field on the task result -- NOT as
            # `input.requested` lifecycle events.
            interrupts = data.get("interrupts") or params.get("interrupts")
            if not interrupts:
                return
            for item in interrupts:
                interrupt_id = _get(item, "id")
                if not interrupt_id:
                    continue
                if interrupt_id in self._emitted_interrupt_ids:
                    continue
                self._emitted_interrupt_ids.add(interrupt_id)
                self._pending_interrupts.append(_get(item, "value"))

        def _push_interrupt(self, payload: Any) -> None:
            self._push(
                CustomEvent(
                    type=EventType.CUSTOM,
                    name=LangGraphEventTypes.OnInterrupt.value,
                    value=payload if isinstance(payload, str) else json.dumps(payload, default=json_safe_stringify, separators=(",", ":")),
                )
            )

        # ------------------------------------------------------------------
        # tools -> TOOL_CALL_RESULT
        # ------------------------------------------------------------------

        def _on_tools(self, params: Dict[str, Any]) -> None:
            data = params.get("data")
            if not isinstance(data, dict):
                return
            if data.get("event") not in ("tool-finished", "tool-error"):
                return
            tool_call_id = data.get("tool_call_id")
            if not tool_call_id:
                return
            output = data.get("output")
            # ToolNode hands the transformer an envelope -- `{status, content}`
            # for the dict shape, or a whole `ToolMessage` -- not the tool's own
            # return value. Emitting the stringified envelope would render
            # `{"status": "success", "content": "..."}` in the UI, so unwrap to
            # the inner content and flatten any list of content blocks.
            content = (data.get("message") or "Tool error") if data.get("event") == "tool-error" else _unwrap_tool_output(output)
            # Match ToolMessage.id (falling back to tool_call_id) exactly as the
            # v2 path in agent.py does, so the MESSAGES_SNAPSHOT merge reconciles
            # this result with its persisted ToolMessage instead of duplicating it.
            message_id = _get(output, "id") or tool_call_id
            self._push(
                ToolCallResultEvent(
                    type=EventType.TOOL_CALL_RESULT,
                    tool_call_id=str(tool_call_id),
                    message_id=str(message_id),
                    content=content,
                    role="tool",
                )
            )
            self._model_made_tool_call = False

        # ------------------------------------------------------------------
        # messages
        # ------------------------------------------------------------------

        def _on_messages(self, params: Dict[str, Any]) -> None:
            # Python/TS divergence. TS delivers the v3 message frame as
            # `params.data` directly; Python's `StreamMessagesHandler` delivers
            # `(payload, metadata)`, where `payload` is either the v3 frame or --
            # on the legacy `on_llm_new_token` path -- an `AIMessageChunk`. Unwrap
            # the pair and ignore anything that isn't a v3 frame; the finalized
            # message still reaches the client through MESSAGES_SNAPSHOT.
            data = _unwrap_messages_payload(params.get("data"))
            if not isinstance(data, dict):
                return
            kind = data.get("event")

            if kind == "message-start":
                # The protocol declares `role` on MessageStartData but the
                # langgraph dev server omits it in practice. Use any
                # message-start as the signal to bind active_message_id; the
                # downstream content-block-start type filter ensures we only
                # emit text events for AI text blocks.
                if not data.get("id"):
                    return
                raw = params.get("data")
                metadata = raw[1] if isinstance(raw, tuple) and len(raw) == 2 else data.get("metadata", {})
                self._predict_state = metadata.get("predict_state", []) if isinstance(metadata, dict) else []
                self._active_message_id = str(data["id"])
                self._bare_text_id_assigned = False
            elif kind == "content-block-start":
                self._on_content_block_start(data)
            elif kind == "content-block-delta":
                self._on_content_block_delta(data)
            elif kind == "content-block-finish":
                self._on_content_block_finish(data)
            elif kind in ("message-finish", "message-error", "error"):
                # `"error"` is what `langchain_protocol.MessageErrorData` actually
                # puts on the wire; `"message-error"` is the name the TS port
                # matches. Accept both -- a stream that ends abnormally must close
                # its blocks under either spelling.
                #
                # The error path is handled identically to `message-finish`:
                # the message is done (abnormally), so close every open block
                # first. Clearing the maps without emitting the END events
                # would leave dangling TEXT_MESSAGE_START / TOOL_CALL_START /
                # REASONING_START that finalize() can no longer close.
                #
                # Even on a clean finish the server can omit
                # `content-block-finish` (for implicitly-opened text blocks
                # reusing a reasoning index and, in practice, for tool /
                # reasoning blocks too); a leftover entry would let the next
                # message's block at the same index overwrite it, so its START
                # would never get an END.
                self._close_open_message_blocks()
                self._active_message_id = None
                self._bare_text_id_assigned = False

        def _on_content_block_start(self, data: Dict[str, Any]) -> None:
            index = data.get("index")
            if index is None:
                return
            content = data.get("content")
            block = content if isinstance(content, dict) else {}
            block_type = block.get("type")

            if block_type == "text":
                if not self._active_message_id:
                    return
                text_id = self._allocate_text_message_id(index)
                self._text_block_message_ids[index] = text_id
                self._push(
                    TextMessageStartEvent(
                        type=EventType.TEXT_MESSAGE_START, message_id=text_id, role="assistant"
                    )
                )
            elif block_type in ("reasoning", "thinking"):
                # Standardized v3 format ("reasoning") plus the older
                # langchain-anthropic alias ("thinking"). Treat the content
                # block as a single reasoning entity scoped to the current
                # message + this content-block index.
                #
                # Prefer the provider's canonical reasoning id (e.g. OpenAI
                # `rs_...`) so the streamed message reconciles with the
                # MESSAGES_SNAPSHOT copy emitted under the same id -- a
                # synthetic id is dropped by the snapshot's replace semantics,
                # wiping the reasoning indicator the moment the end-of-run
                # snapshot lands. The fallback MUST use the same formula as the
                # snapshot converter (`_reasoning_block_to_agui_message`,
                # utils.py) for the same reason.
                if not self._active_message_id:
                    return
                self._saw_streaming_reasoning = True
                reasoning_id = str(
                    block.get("id") or f"{self._active_message_id}-reasoning-{index}"
                )
                tracked = _ReasoningBlock(reasoning_id)
                self._reasoning_blocks[index] = tracked
                self._push(ReasoningStartEvent(type=EventType.REASONING_START, message_id=reasoning_id))
                initial = _reasoning_text(block)
                if initial:
                    self._push(
                        ReasoningMessageStartEvent(
                            type=EventType.REASONING_MESSAGE_START,
                            message_id=reasoning_id,
                            role="reasoning",
                        )
                    )
                    tracked.message_started = True
                    self._push(
                        ReasoningMessageContentEvent(
                            type=EventType.REASONING_MESSAGE_CONTENT,
                            message_id=reasoning_id,
                            delta=initial,
                        )
                    )
                # Anthropic ships the opaque thinking signature on the block;
                # OpenAI Responses run statelessly (store=False) ships
                # `encrypted_content`. Both are the round-trip handle the
                # snapshot converter also preserves, so forward either.
                encrypted = block.get("signature") or block.get("encrypted_content")
                if encrypted:
                    self._push(
                        ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=reasoning_id,
                            encrypted_value=encrypted,
                        )
                    )
            elif block_type == "redacted_thinking":
                # Anthropic redacted_thinking carries opaque encrypted
                # chain-of-thought. Surface as a standalone
                # REASONING_ENCRYPTED_VALUE without opening a visible
                # reasoning message.
                if self._active_message_id and block.get("data"):
                    self._push(
                        ReasoningEncryptedValueEvent(
                            type=EventType.REASONING_ENCRYPTED_VALUE,
                            subtype="message",
                            entity_id=self._active_message_id,
                            encrypted_value=block["data"],
                        )
                    )
            elif block_type in ("tool_call_chunk", "tool_call"):
                tool_call_id = block.get("id") or f"tc-{index}"
                tool_call_name = block.get("name") or ""
                raw_args = block.get("args")
                initial_args = raw_args if isinstance(raw_args, str) else ""
                tool = _ToolBlock(
                    tool_call_id=str(tool_call_id),
                    tool_call_name=str(tool_call_name),
                    args_so_far=initial_args,
                    parent_message_id=self._active_message_id,
                )
                self._tool_blocks[index] = tool
                # Only emit TOOL_CALL_START now if we already have the name.
                # When the name is absent it may arrive on a later block-delta;
                # defer the START (and buffer initial_args) so it never goes out
                # with an empty tool_call_name.
                if tool.tool_call_name:
                    self._ensure_tool_started(tool)

        def _on_content_block_delta(self, data: Dict[str, Any]) -> None:
            index = data.get("index")
            if index is None:
                return
            raw_delta = data.get("delta")
            delta = raw_delta if isinstance(raw_delta, dict) else {}
            delta_type = delta.get("type")

            if delta_type == "text-delta":
                # The server may emit text deltas at a content-block index
                # already occupied by another type (e.g. reasoning at idx=0,
                # then text deltas at idx=0 with no preceding text
                # content-block-start). Treat that as an implicit open: mint a
                # TEXT_MESSAGE_START on the first delta. The END is taken care
                # of on message-finish (or finalize).
                message_id = self._text_block_message_ids.get(index)
                if message_id is None and self._active_message_id:
                    message_id = self._allocate_text_message_id(index)
                    self._text_block_message_ids[index] = message_id
                    self._push(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant"
                        )
                    )
                if message_id is None:
                    return
                self._push(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=message_id,
                        delta=delta.get("text") or "",
                    )
                )
            elif delta_type in ("reasoning-delta", "thinking-delta"):
                tracked = self._reasoning_blocks.get(index)
                if tracked is None:
                    return
                text = delta.get("reasoning") or delta.get("thinking") or ""
                if not text:
                    return
                if not tracked.message_started:
                    self._push(
                        ReasoningMessageStartEvent(
                            type=EventType.REASONING_MESSAGE_START,
                            message_id=tracked.message_id,
                            role="reasoning",
                        )
                    )
                    tracked.message_started = True
                self._push(
                    ReasoningMessageContentEvent(
                        type=EventType.REASONING_MESSAGE_CONTENT,
                        message_id=tracked.message_id,
                        delta=text,
                    )
                )
            elif delta_type == "block-delta":
                self._on_tool_block_delta(index, delta)

        def _on_tool_block_delta(self, index: int, delta: Dict[str, Any]) -> None:
            # BlockDelta carries shallow-merge fields. For tool calls `args` is
            # the FULL cumulative JSON string, not an incremental piece. AG-UI's
            # TOOL_CALL_ARGS expects a delta, so compute it by stripping the
            # prefix we have already sent.
            tool = self._tool_blocks.get(index)
            if tool is None:
                return
            raw_fields = delta.get("fields")
            fields = raw_fields if isinstance(raw_fields, dict) else {}
            name = fields.get("name")
            if name and not tool.tool_call_name:
                tool.tool_call_name = str(name)
            # If START was deferred pending a name and we now have one, emit it
            # (which also flushes the buffered args) before streaming any
            # further args this frame.
            if not tool.started and tool.tool_call_name:
                self._ensure_tool_started(tool)

            args = fields.get("args")
            if not isinstance(args, str):
                return
            cumulative = args
            if not tool.started:
                # Still no name, so START hasn't gone out. Just buffer the full
                # cumulative; _ensure_tool_started will flush it as one delta
                # once the name arrives (or at close, worst case).
                tool.args_so_far = cumulative
                return

            if cumulative.startswith(tool.args_so_far):
                common = len(tool.args_so_far)
            else:
                # The engine replaced the buffer in place (arg correction), so
                # the new value is NOT an extension of what we already streamed.
                # TOOL_CALL_ARGS is append-only with no retraction, so
                # re-sending the full new string would give a
                # delta-concatenating consumer `oldBuffer + newFull`. Instead
                # emit only the part beyond the longest common prefix, so we
                # never re-send the shared head. The already-streamed divergent
                # tail can't be retracted here; the authoritative args are
                # re-delivered in the end-of-run MESSAGES_SNAPSHOT.
                common = _common_prefix_len(tool.args_so_far, cumulative)
            new_delta = cumulative[common:]
            tool.args_so_far = cumulative
            if new_delta:
                self._push(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=tool.tool_call_id,
                        delta=new_delta,
                    )
                )

        def _on_content_block_finish(self, data: Dict[str, Any]) -> None:
            index = data.get("index")
            if index is None:
                return
            # Dispatch by the FINISHING block's type rather than by
            # tracker-presence. Text and reasoning can share an index (the
            # server emits text deltas at the same idx as a reasoning block), so
            # we can't infer the finish target from "first map with this index".
            content = data.get("content")
            finish_type = content.get("type") if isinstance(content, dict) else None

            if finish_type == "text":
                message_id = self._text_block_message_ids.pop(index, None)
                if message_id is not None:
                    self._push(
                        TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)
                    )
            elif finish_type in ("reasoning", "thinking"):
                tracked = self._reasoning_blocks.pop(index, None)
                if tracked is not None:
                    if tracked.message_started:
                        self._push(
                            ReasoningMessageEndEvent(
                                type=EventType.REASONING_MESSAGE_END, message_id=tracked.message_id
                            )
                        )
                    self._push(
                        ReasoningEndEvent(type=EventType.REASONING_END, message_id=tracked.message_id)
                    )
            elif finish_type in ("tool_call_chunk", "tool_call"):
                tool = self._tool_blocks.pop(index, None)
                if tool is not None:
                    # Flush a deferred START (the name may never have arrived)
                    # so the END has a matching START.
                    self._ensure_tool_started(tool)
                    self._push(
                        ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=tool.tool_call_id)
                    )

        # ------------------------------------------------------------------
        # custom -> ManuallyEmit* + generic passthrough
        # ------------------------------------------------------------------

        def _on_custom(self, params: Dict[str, Any]) -> None:
            # Graph nodes can dispatch custom events to drive UI side channels
            # (CopilotKit ManuallyEmit* helpers, app-specific notifications,
            # etc.). v3 routes them through the generic `custom` channel with
            # `data: {name, payload}`. The v2 translation in agent.py expanded
            # the three well-known ManuallyEmit* names into their concrete AG-UI
            # events and passed everything else through as CUSTOM. Mirror that.
            data = params.get("data")
            if not isinstance(data, dict):
                return
            name = data.get("name")
            if not name:
                return
            payload = data.get("payload")

            if name == CustomEventNames.ManuallyEmitMessage.value:
                message_id = _get(payload, "message_id")
                message = _get(payload, "message")
                if message_id and isinstance(message, str):
                    self._push(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=str(message_id),
                            role="assistant",
                        )
                    )
                    self._push(
                        TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            message_id=str(message_id),
                            delta=message,
                        )
                    )
                    self._push(
                        TextMessageEndEvent(
                            type=EventType.TEXT_MESSAGE_END, message_id=str(message_id)
                        )
                    )
                return

            if name == CustomEventNames.ManuallyEmitToolCall.value:
                tool_call_id = _get(payload, "id")
                tool_call_name = _get(payload, "name")
                args = _get(payload, "args")
                if tool_call_id and tool_call_name:
                    self._push(
                        ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=str(tool_call_id),
                            tool_call_name=str(tool_call_name),
                            # v2 (agent.py) uses the tool call id as the parent
                            # message id here; keep the same contract so the
                            # client renders the manual call the same way.
                            parent_message_id=str(tool_call_id),
                        )
                    )
                    delta = args if isinstance(args, str) else _stringify(args)
                    if delta:
                        self._push(
                            ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=str(tool_call_id),
                                delta=delta,
                            )
                        )
                    self._push(
                        ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END, tool_call_id=str(tool_call_id)
                        )
                    )
                return

            if name == CustomEventNames.ManuallyEmitState.value:
                # Manually-emitted state is the source of truth for the
                # following snapshot. Merge into our cache so the next
                # root-terminal flush carries the updated values, AND ship an
                # immediate STATE_SNAPSHOT so consumers can react before the run
                # ends (matches v2 behaviour).
                if isinstance(payload, dict):
                    self._cache_state(payload)
                    self._emit_state_snapshot(payload)
                # Falls through to the generic CUSTOM passthrough below so
                # application listeners that key off the event name still get it.

            # Generic passthrough: forward the event verbatim as CUSTOM.
            self._push(CustomEvent(type=EventType.CUSTOM, name=str(name), value=payload))

    return AGUIStreamTransformer


def _is_root_namespace(namespace: Sequence[Any]) -> bool:
    return len(namespace) == 0


def _get(obj: Any, key: str) -> Any:
    """Read ``key`` from a mapping or an attribute-style object.

    LangGraph delivers interrupts as ``Interrupt`` dataclasses on some paths and
    as plain dicts on others, and custom-event payloads are user-supplied.
    """
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _dump(message: Any) -> Any:
    """Best-effort plain-data view of an AG-UI message for hashing."""
    dump = getattr(message, "model_dump", None)
    if callable(dump):
        return dump()
    return message


def _unwrap_messages_payload(data: Any) -> Any:
    """Return the v3 message frame from a `messages` event's ``data``.

    Python delivers ``(payload, metadata)``; TS delivers the frame directly.
    Accept both shapes.
    """
    if isinstance(data, tuple) and len(data) == 2:
        return data[0]
    return data


def _reasoning_text(block: Dict[str, Any]) -> str:
    for key in ("reasoning", "thinking"):
        value = block.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _unwrap_tool_output(output: Any) -> str:
    """Turn a ``tool-finished`` output into the AG-UI result content string.

    ToolNode wraps the tool's return value in an envelope
    (``{"status": ..., "content": ...}``); the client must see the INNER
    content, never the stringified envelope. A list of content blocks is
    flattened by :func:`normalize_tool_content`, matching what the v2 path in
    agent.py emits for the same tool.
    """
    if isinstance(output, dict) and "content" in output:
        return normalize_tool_content(output["content"])
    # Not an envelope: a ToolMessage-like object, or the raw return value.
    content = _get(output, "content")
    if content is not None:
        return normalize_tool_content(content)
    return normalize_tool_content(output)


_TRANSFORMER_CLASS: Optional[Any] = None


def _resolve_transformer_class() -> Any:
    """Import ``langgraph.stream`` lazily and build (once) the subclass.

    The v3 streaming API landed in langgraph 1.2; this package supports
    ``langgraph>=0.6.0,<2``, so the import must NOT run at module import time
    or ``import ag_ui_langgraph`` would break on every older langgraph.
    """
    global _TRANSFORMER_CLASS
    if _TRANSFORMER_CLASS is not None:
        return _TRANSFORMER_CLASS
    try:
        from langgraph.stream import StreamChannel, StreamTransformer
    except ImportError as exc:  # pragma: no cover - depends on installed langgraph
        raise ImportError(MIN_LANGGRAPH_ERROR) from exc
    _TRANSFORMER_CLASS = _build_transformer_class(StreamTransformer, StreamChannel)
    return _TRANSFORMER_CLASS


def agui_transformer(scope: Tuple[str, ...] = ()) -> Any:
    """Transformer factory for ``graph.compile(transformers=[agui_transformer])``.

    LangGraph calls each registered factory once per ``StreamMux`` as
    ``factory(scope)``, so this function is itself the factory. Pass it
    unparenthesised::

        graph = builder.compile(transformers=[agui_transformer])

    Raises:
        ImportError: When the installed langgraph predates the v3 streaming
            API (``langgraph.stream``), i.e. langgraph < 1.2.
    """
    return _resolve_transformer_class()(scope)
