"""Inbound translator: AG-UI request primitives → OpenAI Agents SDK formats.

Layered so you can grab as much or as little as you need: translate() does
the whole request in one call, translate_<family>() handles a collection,
and translate_<type>() does a single item (override one to tweak just that
mapping). Stateless — make one and reuse it, or make one per request.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from ag_ui.core import (
    ActivityMessage,
    AssistantMessage,
    AudioInputContent,
    BinaryInputContent,
    Context,
    DeveloperMessage,
    DocumentInputContent,
    ImageInputContent,
    Message,
    ReasoningMessage,
    RunAgentInput,
    SystemMessage,
    TextInputContent,
    Tool as AGUITool,
    ToolMessage,
    UserMessage,
    VideoInputContent,
)
from agents import FunctionTool, RunContextWrapper, TResponseInputItem

from .helpers import coerce_to_str, read_attr
from .types import TranslatedInput

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Sentinel exception used by client-tool proxies
# ---------------------------------------------------------------------------

class ClientToolPending(Exception):
    """Raised by a client-tool proxy to signal "stop, the UI owns this call".

    The outer run loop catches it, cancels the SDK run after the current
    turn, and persists the resulting RunState keyed by thread_id so the
    next AG-UI request (which carries an AG-UI ToolMessage with the
    client's result) can resume from the same point.

    Args:
        tool_name: Name of the client-owned tool that was called.
        tool_call_id: The SDK's call_id for this invocation.
        arguments: Raw JSON arguments string the model produced.
    """

    def __init__(self, tool_name: str, tool_call_id: str, arguments: str) -> None:
        super().__init__(
            f"Client tool '{tool_name}' (call_id={tool_call_id}) pending UI execution"
        )
        self.tool_name = tool_name
        self.tool_call_id = tool_call_id
        self.arguments = arguments


# ---------------------------------------------------------------------------
# The translator
# ---------------------------------------------------------------------------

class AGUIToSDKTranslator:
    """Translate AG-UI inbound primitives into OpenAI Agents SDK shapes.

    Example:
        One-shot:

            bundle = AGUIToSDKTranslator().translate(run_input)
            result = Runner.run_streamed(
                agent.clone(tools=agent.tools + bundle.function_tools),
                input=bundle.input_items,
            )

        Per-item:

            translator = AGUIToSDKTranslator()
            items = [translator.translate_user_message(msg) for msg in user_msgs]
            proxy = translator.translate_tool(my_tool)
            image_part = translator.translate_image_content(part)
    """

    # ─────────────────────────────────────────────────────────────────────
    # TIER 1 — One-shot entry point
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, run_input: RunAgentInput) -> TranslatedInput:
        """Translate an entire RunAgentInput into an SDK-ready bundle.

        This is the high-level entry point. It does everything: converts
        messages, wraps tools, and forwards state / context /
        forwarded_props / thread_id / run_id / parent_run_id / resume so
        callers have one object that mirrors ag_ui.core.RunAgentInput
        field-for-field.

        context and resume both pass through unchanged. context items
        (from useCopilotReadable etc.) are not auto-folded into the
        system prompt — call translate_context to format them if your
        agent needs the model to see them.

        Args:
            run_input: The incoming AG-UI RunAgentInput.

        Returns:
            TranslatedInput with translated messages and passthrough
            state/context/forwarded_props.
        """
        # Not every version of RunAgentInput has `resume`, so reach for it with
        # getattr instead of assuming it's there.
        resume = getattr(run_input, "resume", None)
        return TranslatedInput(
            thread_id=run_input.thread_id,
            run_id=run_input.run_id,
            parent_run_id=getattr(run_input, "parent_run_id", None),
            messages=self.translate_messages(run_input.messages or []),
            # tools=self.translate_tools(run_input.tools or []),
            state=run_input.state,
            context=list(run_input.context or []),
            forwarded_props=run_input.forwarded_props,
            resume=list(resume) if resume else None,
        )

    # ─────────────────────────────────────────────────────────────────────
    # TIER 2 — Bulk collections
    # ─────────────────────────────────────────────────────────────────────

    def translate_messages(
        self,
        messages: Iterable[Message],
    ) -> list[TResponseInputItem]:
        """Translate every message and flatten into one Responses-API input list.

        Args:
            messages: AG-UI messages to translate.

        Returns:
            Flattened list of Responses-API input items.
        """
        items = []
        for message in messages:
            items.extend(self.translate_message(message))
        return items

    def translate_tools(
        self,
        tools: Iterable[AGUITool],
    ) -> list[FunctionTool]:
        """Wrap every AG-UI tool as a long-running SDK FunctionTool proxy.

        Args:
            tools: AG-UI client-declared tools.

        Returns:
            SDK FunctionTool proxies, one per input tool.
        """
        return [self.translate_tool(tool) for tool in tools]

    def translate_context(
        self,
        items: Iterable[Context],
    ) -> str:
        """Render ambient context items as a plain-text block for the system prompt.

        AG-UI context carries {description, value} pairs that frontends
        (CopilotKit's useCopilotReadable, etc.) send to give the model
        ambient knowledge about the user's UI state — current page,
        selected item, user identity, etc.

        This does not auto-inject anywhere — callers decide whether to
        prepend the rendered string to a system message, store it in
        agent state, or ignore it.

        The output format is one "Description: value" line per item:

            Description A: value A
            Description B: value B

        Example:
            prompt = "You are helpful."
            ctx = translator.translate_context(bundle.context)
            if ctx:
                prompt = f"{prompt}\\n\\nContext:\\n{ctx}"

        Args:
            items: AG-UI context items.

        Returns:
            Rendered text block, or an empty string when input is empty.
        """
        lines = [
            f"{item.description}: {item.value}"
            for item in items
            if item.description or item.value
        ]
        return "\n".join(lines)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3a — Single message (dispatcher + per-type)
    # ─────────────────────────────────────────────────────────────────────

    def translate_message(self, message: Message) -> list[dict[str, Any]]:
        """Dispatch one AG-UI message to the right per-type translator.

        Returns a list because one message can produce multiple
        Responses-API items (an AssistantMessage with N tool_calls
        splits into 1 message item + N function_call items).

        Args:
            message: An AG-UI message of any supported type.

        Returns:
            Zero or more Responses-API input items.
        """
        if isinstance(message, UserMessage):
            return [self.translate_user_message(message)]
        if isinstance(message, SystemMessage):
            return [self.translate_system_message(message)]
        if isinstance(message, DeveloperMessage):
            return [self.translate_developer_message(message)]
        if isinstance(message, AssistantMessage):
            return self.translate_assistant_message(message)
        if isinstance(message, ToolMessage):
            return [self.translate_tool_message(message)]
        if isinstance(message, ReasoningMessage):
            item = self.translate_reasoning_message(message)
            return [item] if item is not None else []
        if isinstance(message, ActivityMessage):
            item = self.translate_activity_message(message)
            return [item] if item is not None else []
        logger.debug("Unknown AG-UI message type: %s", type(message).__name__)
        return []

    def translate_user_message(self, message: UserMessage) -> dict[str, Any]:
        """Translate a user turn into a Responses-API message item.

        Supports multimodal: message.content may be a string or a list
        of typed content parts (text / image / audio / ...).

        Args:
            message: The AG-UI user message.

        Returns:
            {"type": "message", "role": "user", "content": [...]}
        """
        return {
            "type": "message",
            "role": "user",
            "content": self.translate_content(message.content),
        }

    def translate_system_message(self, message: SystemMessage) -> dict[str, Any]:
        """Translate a system prompt into a Responses-API message item.

        Args:
            message: The AG-UI system message.

        Returns:
            {"type": "message", "role": "system", ...}
        """
        return {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": message.content or ""}],
        }

    def translate_developer_message(self, message: DeveloperMessage) -> dict[str, Any]:
        """Translate a developer prompt into a Responses-API message item.

        OpenAI's newer model lineage (GPT-4o+, o1) accepts role:
        developer as a higher-priority alternative to system.

        Args:
            message: The AG-UI developer message.

        Returns:
            {"type": "message", "role": "developer", ...}
        """
        return {
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": message.content or ""}],
        }

    def translate_assistant_message(
        self,
        message: AssistantMessage,
    ) -> list[dict[str, Any]]:
        """Translate an assistant turn into message + function_call items.

        The Responses API splits assistant tool calls into separate
        items (one message for any spoken text, plus one function_call
        per invocation) — so one AG-UI message can produce N+1 items.

        Args:
            message: The AG-UI assistant message.

        Returns:
            Optional text message item followed by one function_call
            item per tool call.
        """
        items: list[dict[str, Any]] = []
        text = message.content or ""
        if text:
            items.append(
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": text}],
                }
            )
        for tool_call in message.tool_calls or []:
            items.append(
                {
                    "type": "function_call",
                    "call_id": tool_call.id,
                    "name": tool_call.function.name,
                    "arguments": tool_call.function.arguments or "",
                }
            )
        return items

    def translate_tool_message(self, message: ToolMessage) -> dict[str, Any]:
        """Translate a tool result into a function_call_output item.

        Args:
            message: The AG-UI tool message.

        Returns:
            {"type": "function_call_output", ...}
        """
        return {
            "type": "function_call_output",
            "call_id": message.tool_call_id,
            "output": message.content or "",
        }

    def translate_reasoning_message(
        self,
        message: ReasoningMessage,
    ) -> dict[str, Any] | None:
        """Translate a reasoning trace into a reasoning item, if replayable.

        OpenAI o-series models can re-ingest encrypted reasoning blobs
        (the encrypted_value field) but treat plaintext reasoning as
        opaque. A reasoning item is only emitted when an encrypted value
        is present; otherwise the message is dropped with a debug log.

        Args:
            message: The AG-UI reasoning message.

        Returns:
            {"type": "reasoning", ...}, or None if not replayable.
        """
        if not message.encrypted_value:
            logger.debug(
                "Dropping ReasoningMessage id=%s: no encrypted_value to re-ingest",
                message.id,
            )
            return None
        return {
            "type": "reasoning",
            "id": message.id,
            "encrypted_content": message.encrypted_value,
            "summary": [{"type": "summary_text", "text": message.content or ""}],
        }

    def translate_activity_message(
        self,
        message: ActivityMessage,
    ) -> dict[str, Any] | None:
        """Translate an activity status message — dropped by default.

        Activity messages describe UI side-effects (e.g. "user
        navigated") that the model doesn't need to ingest. Subclasses
        can override to fold them into the system prompt if a
        particular use case needs it.

        Args:
            message: The AG-UI activity message.

        Returns:
            Always None; no Responses-API equivalent exists.
        """
        logger.debug(
            "Dropping ActivityMessage id=%s activity_type=%s",
            message.id,
            message.activity_type,
        )
        return None

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3b — Single tool
    # ─────────────────────────────────────────────────────────────────────

    def translate_tool(self, tool: AGUITool) -> FunctionTool:
        """Wrap one AG-UI Tool as an SDK FunctionTool proxy.

        The proxy's invocation handler raises ClientToolPending so the
        outer run loop can pause the SDK and hand control back to the
        client.

        Args:
            tool: The AG-UI client-declared tool.

        Returns:
            An SDK FunctionTool proxy for the tool.
        """
        schema = self._ensure_object_schema(tool.parameters)

        async def on_invoke_tool(
            ctx: RunContextWrapper[Any],
            arguments_json: str,
        ) -> str:
            call_id = getattr(ctx, "tool_call_id", None) or ""
            raise ClientToolPending(
                tool_name=tool.name,
                tool_call_id=call_id,
                arguments=arguments_json or "",
            )

        return FunctionTool(
            name=tool.name,
            description=tool.description or "",
            params_json_schema=schema,
            on_invoke_tool=on_invoke_tool,
            strict_json_schema=False,
        )

    # ─────────────────────────────────────────────────────────────────────
    # TIER 3c — Content parts (multimodal)
    # ─────────────────────────────────────────────────────────────────────

    def translate_content(self, content: Any) -> list[dict[str, Any]]:
        """Translate a message content field (str or list of parts) to input parts.

        A string is wrapped as a single input_text part. A list has
        each part passed through translate_content_part. Anything else
        is best-effort stringified.

        Args:
            content: The message's content field.

        Returns:
            List of Responses-API input parts.
        """
        if isinstance(content, str):
            return [{"type": "input_text", "text": content}]
        if isinstance(content, list):
            parts: list[dict[str, Any]] = []
            for part in content:
                converted = self.translate_content_part(part)
                if converted is not None:
                    parts.append(converted)
            if parts:
                return parts
        return [{"type": "input_text", "text": coerce_to_str(content)}]

    def translate_content_part(self, part: Any) -> dict[str, Any] | None:
        """Dispatch one content part to its per-type translator.

        Args:
            part: A single typed or dict-shaped content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        if isinstance(part, TextInputContent):
            return self.translate_text_content(part)
        if isinstance(part, ImageInputContent):
            return self.translate_image_content(part)
        if isinstance(part, AudioInputContent):
            return self.translate_audio_content(part)
        if isinstance(part, VideoInputContent):
            return self.translate_video_content(part)
        if isinstance(part, DocumentInputContent):
            return self.translate_document_content(part)
        if isinstance(part, BinaryInputContent):
            return self.translate_binary_content(part)
        # Not a typed part — probably a raw dict from loosely-parsed JSON.
        # Fall back to sniffing it by shape.
        return self._dispatch_dict_content_part(part)

    def translate_text_content(self, part: TextInputContent) -> dict[str, Any]:
        """Translate a TextInputContent part.

        Args:
            part: The AG-UI text content part.

        Returns:
            {"type": "input_text", "text": ...}
        """
        return {"type": "input_text", "text": part.text or ""}

    def translate_image_content(
        self,
        part: ImageInputContent,
    ) -> dict[str, Any] | None:
        """Translate an ImageInputContent part.

        URL sources pass through unchanged. Data sources become base64
        data URLs so the Responses-API image_url field always receives
        a single string.

        Args:
            part: The AG-UI image content part.

        Returns:
            {"type": "input_image", "image_url": ...}, or None if the
            source has no usable value.
        """
        url = self._data_source_to_url(part.source)
        if url is None:
            return None
        return {"type": "input_image", "image_url": url}

    def translate_audio_content(
        self,
        part: AudioInputContent,
    ) -> dict[str, Any] | None:
        """Translate an AudioInputContent part.

        The Responses API accepts base64 audio data with a short format
        tag (wav, mp3). The format is extracted from the mime type. URL
        sources are not supported by the API for audio — they get
        dropped.

        Args:
            part: The AG-UI audio content part.

        Returns:
            {"type": "input_audio", "input_audio": {...}}, or None if
            unsupported.
        """
        source_type = read_attr(part.source, "type")
        value = read_attr(part.source, "value")
        mime = read_attr(part.source, "mime_type")
        if not value or source_type != "data":
            logger.debug("Dropping audio part: only data sources are supported")
            return None
        return {
            "type": "input_audio",
            "input_audio": {
                "data": value,
                "format": self._audio_format_from_mime(mime),
            },
        }

    def translate_video_content(
        self,
        part: VideoInputContent,
    ) -> dict[str, Any] | None:
        """Translate a VideoInputContent part — dropped by default.

        The Responses API has no native video input. Override this in
        a subclass to swap in a placeholder or extract frames.

        Args:
            part: The AG-UI video content part.

        Returns:
            Always None.
        """
        logger.debug("Dropping video part: Responses API does not accept video input")
        return None

    def translate_document_content(
        self,
        part: DocumentInputContent,
    ) -> dict[str, Any] | None:
        """Translate a DocumentInputContent part.

        URL sources use file_url; data sources use file_data (base64).

        Args:
            part: The AG-UI document content part.

        Returns:
            {"type": "input_file", ...}, or None if no usable value.
        """
        source_type = read_attr(part.source, "type")
        value = read_attr(part.source, "value")
        mime = read_attr(part.source, "mime_type")
        if not value:
            return None
        if source_type == "url":
            return {"type": "input_file", "file_url": value}
        if source_type == "data":
            return {
                "type": "input_file",
                "file_data": f"data:{mime or 'application/octet-stream'};base64,{value}",
            }
        return None

    def translate_binary_content(
        self,
        part: BinaryInputContent,
    ) -> dict[str, Any] | None:
        """Translate a BinaryInputContent part, routed by mime type.

        Binary parts are a polymorphic catch-all: they may be images,
        audio, documents, etc. The mime type is sniffed and routed to
        the corresponding Responses-API input shape. Unknown types are
        dropped.

        Args:
            part: The AG-UI binary content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        mime = part.mime_type or "application/octet-stream"

        if mime.startswith("image/"):
            return self._binary_as_image(part)
        if mime.startswith("audio/"):
            return self._binary_as_audio(part, mime)
        # Treat anything else (pdf, text, application/*) as a file.
        return self._binary_as_file(part, mime)

    # ─────────────────────────────────────────────────────────────────────
    # TIER 4 — Internal helpers
    # ─────────────────────────────────────────────────────────────────────

    def _ensure_object_schema(self, parameters: Any) -> dict[str, Any]:
        """Normalize a possibly-empty tool parameter spec into a JSON Schema object.

        The Responses API requires every function tool's schema to be a
        JSON Schema object. AG-UI tools sometimes ship parameter-less
        specs as None or {}; those get coerced to an empty-but-valid
        object.

        Args:
            parameters: The tool's raw parameter spec.

        Returns:
            A valid JSON Schema object.
        """
        if not isinstance(parameters, dict) or "type" not in parameters:
            return {"type": "object", "properties": {}, "additionalProperties": True}
        return parameters

    @staticmethod
    def _data_source_to_url(source: Any) -> str | None:
        """Render a content source (data or url) as a single string for image_url.

        URL sources pass through. Data sources become
        data:<mime>;base64,<value>.

        Args:
            source: The content part's source object.

        Returns:
            The resolved URL string, or None if there's no usable value.
        """
        if source is None:
            return None
        source_type = read_attr(source, "type")
        value = read_attr(source, "value")
        if not value:
            return None
        if source_type == "url":
            return value
        if source_type == "data":
            mime = read_attr(source, "mime_type") or "application/octet-stream"
            return f"data:{mime};base64,{value}"
        return None

    @staticmethod
    def _audio_format_from_mime(mime: str | None) -> str:
        """Map a mime type to the short format string the Responses API wants.

        Args:
            mime: The audio mime type, or None.

        Returns:
            A short format tag (e.g. "wav", "mp3").
        """
        if not mime:
            return "wav"
        subtype = mime.split("/", 1)[-1].lower()
        # Same audio, lots of names for it — fold the common ones together.
        if subtype in ("mpeg", "mpeg3", "mp3"):
            return "mp3"
        if subtype in ("x-wav", "wav", "wave"):
            return "wav"
        return subtype

    def _dispatch_dict_content_part(
        self,
        part: Any,
    ) -> dict[str, Any] | None:
        """Best-effort dispatch for dict-shaped content parts (loose typing).

        Sometimes content arrives as raw dicts rather than pydantic
        objects (e.g. when callers hand-craft inputs). The type field
        is sniffed and routed.

        Args:
            part: A dict-shaped (or duck-typed) content part.

        Returns:
            The translated input part, or None if unsupported.
        """
        part_type = read_attr(part, "type")
        if part_type == "text":
            text = read_attr(part, "text")
            if text is None:
                return None
            return {"type": "input_text", "text": text}
        if part_type == "image":
            url = self._data_source_to_url(read_attr(part, "source"))
            return {"type": "input_image", "image_url": url} if url else None
        # Don't recognize it — skip it rather than guess.
        return None

    # -- Helpers for translate_binary_content, split out to keep it readable

    def _binary_as_image(self, part: BinaryInputContent) -> dict[str, Any] | None:
        if part.url:
            return {"type": "input_image", "image_url": part.url}
        if part.data:
            mime = part.mime_type or "application/octet-stream"
            return {"type": "input_image", "image_url": f"data:{mime};base64,{part.data}"}
        return None

    def _binary_as_audio(
        self,
        part: BinaryInputContent,
        mime: str,
    ) -> dict[str, Any] | None:
        if not part.data:
            logger.debug("Dropping binary audio: URL-only audio not supported")
            return None
        return {
            "type": "input_audio",
            "input_audio": {
                "data": part.data,
                "format": self._audio_format_from_mime(mime),
            },
        }

    def _binary_as_file(
        self,
        part: BinaryInputContent,
        mime: str,
    ) -> dict[str, Any] | None:
        if part.url:
            return {"type": "input_file", "file_url": part.url}
        if part.data:
            payload = {
                "type": "input_file",
                "file_data": f"data:{mime};base64,{part.data}",
            }
            if part.filename:
                payload["filename"] = part.filename
            return payload
        return None


__all__ = [
    "AGUIToSDKTranslator",
    "ClientToolPending",
]
