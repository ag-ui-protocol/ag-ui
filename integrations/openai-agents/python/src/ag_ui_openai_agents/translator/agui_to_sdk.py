"""Inbound translator: AG-UI request primitives → OpenAI Agents SDK formats.

Layered API (each tier is callable on its own — they build on each other):

    Tier 1 — One-shot:
        translate(run_input)              → TranslatedInput (everything wired up)

    Tier 2 — Bulk collections:
        translate_messages(messages)      → list[input item]
        translate_tools(tools)            → list[FunctionTool]
        translate_context(items)          → str (formatted text block)

    Tier 3 — Single items (per AG-UI type):
        translate_message(msg)            → list[input item]   (dispatcher)
            translate_user_message
            translate_system_message
            translate_developer_message
            translate_assistant_message
            translate_tool_message
            translate_reasoning_message
            translate_activity_message
        translate_tool(tool)              → FunctionTool
        translate_content(content)        → list[input part]   (dispatcher)
        translate_content_part(part)      → input part | None  (dispatcher)
            translate_text_content
            translate_image_content
            translate_audio_content
            translate_video_content
            translate_document_content
            translate_binary_content

    Tier 4 — Internal helpers (underscore-prefixed).

The translator is **stateless** — instantiate it once and reuse, or call
methods on a throwaway instance per request. Either works.
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

    The outer run loop catches it, cancels the SDK run after the current turn,
    and persists the resulting ``RunState`` keyed by ``thread_id`` so the next
    AG-UI request (which carries an AG-UI ``ToolMessage`` with the client's
    result) can resume from the same point.
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
    """Translate AG-UI inbound primitives into shapes the OpenAI Agents SDK expects.

    Examples
    --------
    One-shot::

        bundle = AGUIToSDKTranslator().translate(run_input)
        result = Runner.run_streamed(
            agent.clone(tools=agent.tools + bundle.function_tools),
            input=bundle.input_items,
        )

    Per-item::

        translator = AGUIToSDKTranslator()
        items = [translator.translate_user_message(msg) for msg in user_msgs]
        proxy = translator.translate_tool(my_tool)
        image_part = translator.translate_image_content(part)
    """

    # ─────────────────────────────────────────────────────────────────────
    # TIER 1 — One-shot entry point
    # ─────────────────────────────────────────────────────────────────────

    def translate(self, run_input: RunAgentInput) -> TranslatedInput:
        """
        Translate an entire ``RunAgentInput`` into an SDK-ready bundle.

        This is the high-level entry point. It does everything: converts
        messages, wraps tools, and forwards state / context / forwarded_props /
        thread_id / run_id / parent_run_id / resume so callers have one object
        that mirrors :class:`ag_ui.core.RunAgentInput` field-for-field.

        Note on ``context`` and ``resume``: both pass through **unchanged**.
        ``context`` items (from ``useCopilotReadable`` etc.) are not auto-folded
        into the system prompt — call :meth:`translate_context` to format them
        if your agent needs the model to see them.
        """
        # ``resume`` was added in the TypeScript SDK first; the Python SDK
        # may not expose it yet — read defensively so older SDK versions
        # don't break us.
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
        """Translate every message and flatten into one Responses-API input list."""
        items = []
        for message in messages:
            items.extend(self.translate_message(message))
        return items

    def translate_tools(
        self,
        tools: Iterable[AGUITool],
    ) -> list[FunctionTool]:
        """Wrap every AG-UI tool as a long-running SDK :class:`FunctionTool` proxy."""
        return [self.translate_tool(tool) for tool in tools]

    def translate_context(
        self,
        items: Iterable[Context],
    ) -> str:
        """Render ambient context items as a plain-text block for the system prompt.

        AG-UI ``context`` carries ``{description, value}`` pairs that frontends
        (CopilotKit's ``useCopilotReadable``, etc.) send to give the model
        ambient knowledge about the user's UI state — current page, selected
        item, user identity, etc.

        We do **not** auto-inject this anywhere — callers decide whether to
        prepend the rendered string to a system message, store it in agent
        state, or ignore it. Returns an empty string when the input is empty.

        Output format::

            Description A: value A
            Description B: value B

        Example::

            prompt = "You are helpful."
            ctx = translator.translate_context(bundle.context)
            if ctx:
                prompt = f"{prompt}\\n\\nContext:\\n{ctx}"
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

        Returns a **list** because one message can produce multiple Responses-API
        items (an AssistantMessage with N tool_calls splits into 1 message item
        + N function_call items).
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
        """User turn → ``{"type": "message", "role": "user", "content": [...]}``.

        Supports multimodal: ``message.content`` may be a string or a list of
        typed content parts (text / image / audio / ...).
        """
        return {
            "type": "message",
            "role": "user",
            "content": self.translate_content(message.content),
        }

    def translate_system_message(self, message: SystemMessage) -> dict[str, Any]:
        """System prompt → ``{"type": "message", "role": "system", ...}``."""
        return {
            "type": "message",
            "role": "system",
            "content": [{"type": "input_text", "text": message.content or ""}],
        }

    def translate_developer_message(self, message: DeveloperMessage) -> dict[str, Any]:
        """Developer prompt → ``{"type": "message", "role": "developer", ...}``.

        OpenAI's newer model lineage (GPT-4o+, o1) accepts ``role: developer``
        as a higher-priority alternative to ``system``.
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
        """Assistant turn → optional text message + one ``function_call`` per tool call.

        The Responses API splits assistant tool calls into separate items
        (one ``message`` for any spoken text, plus one ``function_call`` per
        invocation) — so one AG-UI message can produce N+1 items.
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
        """Tool result → ``{"type": "function_call_output", ...}``."""
        return {
            "type": "function_call_output",
            "call_id": message.tool_call_id,
            "output": message.content or "",
        }

    def translate_reasoning_message(
        self,
        message: ReasoningMessage,
    ) -> dict[str, Any] | None:
        """Reasoning trace → ``{"type": "reasoning", ...}`` if usable, else ``None``.

        OpenAI o-series models can re-ingest *encrypted* reasoning blobs (the
        ``encrypted_value`` field) but treat plaintext reasoning as opaque.
        We only emit a reasoning item when an encrypted value is present;
        otherwise we drop the message with a debug log.
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
        """Activity status → dropped by default (no Responses-API equivalent).

        Activity messages describe UI side-effects (e.g. "user navigated") that
        the model doesn't need to ingest. Subclasses can override to fold them
        into the system prompt if a particular use case needs it.
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
        """
        Wrap one AG-UI :class:`Tool` as an SDK :class:`FunctionTool` proxy.

        The proxy's invocation handler raises :class:`ClientToolPending` so the
        outer run loop can pause the SDK and hand control back to the client.
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
        """Translate a message ``content`` field (str or list of parts) to input parts.

        * String → wrapped as a single ``input_text`` part.
        * List → each part passed through :meth:`translate_content_part`.
        * Anything else → best-effort stringification.
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
        """Dispatch one content part to its per-type translator."""
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
        # Duck-typed fallback for dict-style parts (e.g. from JSON without strict parsing).
        return self._dispatch_dict_content_part(part)

    def translate_text_content(self, part: TextInputContent) -> dict[str, Any]:
        """``TextInputContent`` → ``{"type": "input_text", "text": ...}``."""
        return {"type": "input_text", "text": part.text or ""}

    def translate_image_content(
        self,
        part: ImageInputContent,
    ) -> dict[str, Any] | None:
        """``ImageInputContent`` → ``{"type": "input_image", "image_url": ...}``.

        URL sources pass through unchanged. Data sources become base64 data URLs
        so the Responses-API ``image_url`` field always receives a single string.
        """
        url = self._data_source_to_url(part.source)
        if url is None:
            return None
        return {"type": "input_image", "image_url": url}

    def translate_audio_content(
        self,
        part: AudioInputContent,
    ) -> dict[str, Any] | None:
        """``AudioInputContent`` → ``{"type": "input_audio", "input_audio": {...}}``.

        The Responses API accepts base64 audio data with a short format tag
        (``wav``, ``mp3``). We extract the format from the mime type. URL
        sources are not supported by the API for audio — they get dropped.
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
        """``VideoInputContent`` → dropped (Responses API has no native video input).

        Override this in a subclass to swap in a placeholder or extract frames.
        """
        logger.debug("Dropping video part: Responses API does not accept video input")
        return None

    def translate_document_content(
        self,
        part: DocumentInputContent,
    ) -> dict[str, Any] | None:
        """``DocumentInputContent`` → ``{"type": "input_file", ...}``.

        URL sources use ``file_url``; data sources use ``file_data`` (base64).
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
        """``BinaryInputContent`` → routed by mime type.

        Binary parts are a polymorphic catch-all: they may be images, audio,
        documents, etc. We sniff the mime type and route to the corresponding
        Responses-API input shape. Unknown types are dropped.
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
        """Normalise a possibly-empty tool parameter spec into a JSON Schema object.

        The Responses API requires every function tool's schema to be a JSON
        Schema object. AG-UI tools sometimes ship parameter-less specs as
        ``None`` or ``{}``; we coerce those to an empty-but-valid object.
        """
        if not isinstance(parameters, dict) or "type" not in parameters:
            return {"type": "object", "properties": {}, "additionalProperties": True}
        return parameters

    @staticmethod
    def _data_source_to_url(source: Any) -> str | None:
        """Render a content source (data or url) as a single string for ``image_url``.

        * URL sources → pass through.
        * Data sources → ``data:<mime>;base64,<value>``.
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
        """Map a mime type to the short format string the Responses API wants."""
        if not mime:
            return "wav"
        subtype = mime.split("/", 1)[-1].lower()
        # Common normalisations.
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

        Sometimes content arrives as raw dicts rather than pydantic objects
        (e.g. when callers hand-craft inputs). We sniff ``type`` and route.
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
        # Unknown / unsupported.
        return None

    # -- Binary-routing sub-helpers (internal, used only by translate_binary_content)

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
