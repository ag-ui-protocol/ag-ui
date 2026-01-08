"""
AG-UI span processor for pyagentspec.tracing

This module bridges pyagentspec.tracing spans/events to AG-UI events
(`ag_ui.core.events`). It mirrors the behavior of the exporter used in the
telemetry package but adapts to the event shapes defined under
`pyagentspec.tracing.events`.

Notes/limitations for the pyagentspec.tracing version:
- LLM streaming uses `LlmGenerationChunkReceived` with chunk_type MESSAGE only;
  tool-call streaming chunks are not available in this event set.
- Tool execution events in this namespace do not include `message_id` nor
  `tool_call_id`; therefore, we do not emit AG-UI tool call lifecycle or
  result events here.
"""

from __future__ import annotations

import ast
import os
import json
import uuid
import logging
logger = logging.getLogger(__file__)
from contextvars import ContextVar
from typing import Any, Dict, Optional, List

# AG‑UI Python SDK (events)
from ag_ui.core.events import (
    RunFinishedEvent,
    RunStartedEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageChunkEvent,
    ToolCallResultEvent,
    ToolCallChunkEvent,
    ActivitySnapshotEvent,
)

from pyagentspec.tracing.events.exception import ExceptionRaised
from pyagentspec.tracing.events.event import Event
from pyagentspec.tracing.events.llmgeneration import (
    LlmGenerationChunkReceived,
    LlmGenerationRequest,
    LlmGenerationResponse,
)
from pyagentspec.tracing.events.tool import (
    ToolExecutionRequest,
    ToolExecutionResponse,
)
from pyagentspec.tracing.spanprocessor import SpanProcessor
from pyagentspec.tracing.spans import LlmGenerationSpan, NodeExecutionSpan, ToolExecutionSpan
from pyagentspec.tracing.spans.span import Span


# ContextVar used to bridge events into the FastAPI endpoint queue. The server
# should set this per request to an asyncio.Queue that receives AG‑UI events.
EVENT_QUEUE = ContextVar("AG_UI_EVENT_QUEUE", default=None)


class AgUiSpanProcessor(SpanProcessor):
    """Translate pyagentspec.tracing spans/events into AG-UI events.

    Emission strategy:
    - Run lifecycle: RUN_STARTED on startup, RUN_FINISHED on shutdown
    - Node spans: STEP_STARTED on start, STEP_FINISHED on end
    - LLM text streaming: on first chunk, mark started; emit TEXT_MESSAGE_CHUNK
    - LLM response: if no chunks, emit a single TEXT_MESSAGE_CHUNK; mark ended
    """

    def __init__(self, runtime: str) -> None:
        self._run = {"thread_id": str(uuid.uuid4()), "run_id": str(uuid.uuid4())}
        self._debug = os.getenv("AGUI_DEBUG", "").lower() in ("1", "true", "yes", "on")
        # Track if any text chunk has been emitted for a given LLM span
        self._llm_chunks_seen: Dict[str, bool] = {}
        # Track tool-call lifecycles seen via streaming to avoid double-emitting
        self._started_tool_calls: Dict[str, Any] = {}
        self._runtime = runtime

    def _emit(self, event_obj) -> None:
        queue = EVENT_QUEUE.get()
        if queue is None:
            raise RuntimeError("AG-UI event queue is not set")
        queue.put_nowait(event_obj)
        if self._debug:
            print("[AGUI DEBUG]" + str(event_obj))

    @staticmethod
    def _escape_html(text: str) -> str:
        if text is None:
            return ""
        return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    def startup(self) -> None:
        self._emit(RunStartedEvent(thread_id=self._run["thread_id"], run_id=self._run["run_id"]))

    def shutdown(self) -> None:
        self._emit(RunFinishedEvent(thread_id=self._run["thread_id"], run_id=self._run["run_id"]))

    def on_start(self, span: Span) -> None:
        # Prefer span lifecycle for step/tool tracking; events fill in details
        if isinstance(span, LlmGenerationSpan):
            self._llm_chunks_seen[span.id] = False
        elif isinstance(span, NodeExecutionSpan):
            step_name = span.node.name
            self._emit(StepStartedEvent(step_name=step_name))
        elif isinstance(span, ToolExecutionSpan):
            # Do not synthesize AG‑UI tool-call lifecycle here; tool-call lifecycle maps
            # to LLM ToolCallChunkReceived/LlmGenerationResponse events instead.
            pass

    async def on_start_async(self, span: "Span") -> None:
        self.on_start(span)

    def on_end(self, span: "Span") -> None:
        # Cleanup / close via span lifecycle where possible
        if isinstance(span, LlmGenerationSpan):
            self._llm_chunks_seen.pop(span.id, None)
        elif isinstance(span, NodeExecutionSpan):
            step_name = span.node.name
            self._emit(StepFinishedEvent(step_name=step_name))
        elif isinstance(span, ToolExecutionSpan):
            # No synthesized tool-call lifecycle on tool span end
            pass

    # Event routing
    def on_event(self, event: Event, span: Span, *args: Any, **kwargs: Any) -> None:
        # if an error is raised, then args will contain something, to fix this
        match event:
            case LlmGenerationChunkReceived():
                # WayFlow does not assign completion_id in streaming, falling back to request_id
                message_id = event.completion_id or event.request_id
                if not message_id:
                    raise ValueError("Expected assistant message id for text chunk")
                if event.content:
                    self._emit(
                        TextMessageChunkEvent(
                            message_id=message_id,
                            role="assistant",
                            delta=self._escape_html(event.content),
                        )
                    )
                    self._llm_chunks_seen[span.id] = True
                if event.tool_calls:
                    if len(event.tool_calls) != 1:
                        raise ValueError("expected exactly one tool call chunk")
                    tool_call_chunk = event.tool_calls[0]
                    tool_name = tool_call_chunk.tool_name
                    tool_call_id = tool_call_chunk.call_id
                    if tool_call_id not in self._started_tool_calls:
                        self._started_tool_calls[tool_call_id] = {
                            "message_id": message_id
                        }
                    self._emit(
                        ToolCallChunkEvent(
                            tool_call_id=tool_call_id,
                            parent_message_id=message_id,
                            tool_call_name=tool_name,
                            delta=tool_call_chunk.arguments,
                        )
                    )
            case LlmGenerationRequest():
                # We ignore this for now, it's not needed for AG-UI
                return
            case LlmGenerationResponse():
                message_id = event.completion_id
                if not message_id:
                    raise ValueError("Expected assistant message id in LLM response")
                completion_text = event.content or ""
                
                # Non-strict: best-effort detect A2UI JSON, otherwise emit text
                a2ui_payload = _extract_a2ui_payload(completion_text)
                if a2ui_payload is not None:
                    try:
                        content_obj = a2ui_payload
                        content_obj = _normalize_a2ui_operations(content_obj)
                        # if we use a random id here, it will not delete the streamed JSON from the UI, but if we use message_id, then it will delete the JSON and render the actual component instead
                        self._emit(
                            ActivitySnapshotEvent(
                                message_id=message_id,
                                activity_type="a2ui-surface",
                                content=content_obj,
                                replace=True,
                            )
                        )
                    except Exception:
                        # Fall back to text on any parsing/validation failure
                        if not self._llm_chunks_seen.get(span.id, False) and completion_text:
                            self._emit(
                                TextMessageChunkEvent(
                                    message_id=message_id,
                                    role="assistant",
                                    delta=self._escape_html(completion_text),
                                )
                            )
                            self._llm_chunks_seen[span.id] = True
                else:
                    # If no text chunks were streamed in this span, emit the full completion text as a single content event
                    if not self._llm_chunks_seen.get(span.id, False):
                        if completion_text:
                            self._emit(
                                TextMessageChunkEvent(
                                    message_id=message_id,
                                    role="assistant",
                                    delta=self._escape_html(completion_text),
                                )
                            )
                        self._llm_chunks_seen[span.id] = True
                # if a tool_call was not streamed, we emit it here
                for tool_call in event.tool_calls:
                    if tool_call.call_id not in self._started_tool_calls:
                        self._emit(
                            ToolCallChunkEvent(
                                tool_call_id=tool_call.call_id,
                                parent_message_id=message_id,
                                tool_call_name=tool_call.tool_name,
                                delta=tool_call.arguments,
                            )
                        )
                        self._started_tool_calls[tool_call.call_id] = {
                            "message_id": message_id
                        }
            case ToolExecutionRequest():
                if self._runtime != "langgraph" and event.request_id not in self._started_tool_calls:
                    self._emit(
                        ToolCallChunkEvent(
                            tool_call_id=event.request_id,
                            tool_call_name=event.tool.name,
                            delta=json.dumps(event.inputs),
                        )
                    )
                    self._started_tool_calls[event.request_id] = {
                        "message_id": span.id  # no need for accurate message_id here
                    }
            case ToolExecutionResponse():
                tool_call_id = event.request_id
                if not tool_call_id:
                    raise ValueError("Expected tool_call_id in tool execution response")
                message_id = self._started_tool_calls[tool_call_id]["message_id"]
                content = _normalize_tool_output(event.outputs)
                self._emit(
                    ToolCallResultEvent(
                        message_id=message_id,
                        tool_call_id=tool_call_id,
                        content=content,
                        role="tool",
                    )
                )
            case ExceptionRaised():
                raise RuntimeError("[AG-UI SpanProcessor] Exception occurred during agent execution:" + event.exception_message + f"\n\nStacktrace: {event.exception_stacktrace}")
            case _:
                return

    async def on_event_async(self, event: Event, span: Span) -> None:
        return self.on_event(self, event, span)

    async def on_end_async(self, span: "Span") -> None:
        self.on_end(span)

    async def shutdown_async(self) -> None:
        self.shutdown()

    async def startup_async(self) -> None:
        self.startup()


def _normalize_tool_output(outputs: Any) -> str:
    """Return a JSON string for AG-UI ToolCallResultEvent.content without double-encoding.

    Rules:
    - If outputs is a dict with a single key (e.g., {"weather_result": <value>}) and the inner
        value is itself JSON-like (dict/list or a JSON string), unwrap to the inner value for UI convenience.
    - If content is already a dict/list, serialize exactly once via json.dumps.
    - If content is a string that is valid JSON, pass it through unchanged (don’t wrap again).
    - Otherwise, stringify primitives.
    """
    content: Any = outputs
    # Unwrap single-key dicts to their inner value when appropriate
    if isinstance(outputs, dict) and len(outputs) == 1:
        inner = next(iter(outputs.values()))
        # If inner is a dict/list, prefer that directly; if it's a JSON string, keep as string
        if isinstance(inner, (dict, list)):
            content = inner
        else:
            content = inner
    # If it’s already a dict/list, serialize exactly once
    if isinstance(content, (dict, list)):
        return json.dumps(content)
    # If it’s a string that looks like JSON, pass through as-is (frontend will parse)
    if isinstance(content, str) and jsonable(content):
        return content
    if isinstance(content, str):
        try:
            content_dict = ast.literal_eval(content)
            return json.dumps(content_dict)
        except:
            pass
    # Fallback: stringify primitives
    return str(content)


def jsonable(string):
    try:
        json.loads(string)
        return True
    except:
        return False


def _extract_a2ui_payload(text: str) -> Optional[str]:
    """Extract A2UI JSON payload if model output follows with-a2a-a2ui style.

    Accepts either a raw JSON (array/object) or a two-part string separated by
    '---a2ui_JSON---' where the trailing segment is the JSON payload.
    Returns the JSON string if found, else None.
    """
    if not text:
        return None
    s = text.strip()
    if (s.startswith("[") and s.endswith("]")) or (s.startswith("{") and s.endswith("}")):
        return s
    delimiter = "---a2ui_JSON---"
    if delimiter in s:
        try:
            _, json_part = s.split(delimiter, 1)
            return json_part.strip().lstrip("```json").rstrip("```").strip()
        except Exception:
            return None
    return None


def _normalize_a2ui_operations(payload: str) -> dict:
    logger.error("RAW generated A2UI JSON with type=%s: %s", type(payload), payload)
    content_obj = json.loads(payload)
    # to be compatible with the A2UI renderer, the content of the ActivitySnapshot event should be a dict with a single key "operations"
    # see L390 in ag-ui/integrations/a2a/typescript/src/utils.ts
    if isinstance(content_obj, list):
        content_obj = {"operations": content_obj}
    elif isinstance(content_obj, dict) and "operations" not in content_obj:
        content_obj = {"operations": [content_obj]}
    return content_obj
