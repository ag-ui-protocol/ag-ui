import json
import logging
import re
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, ConfigDict, TypeAdapter, model_validator
from pydantic.alias_generators import to_camel
from pydantic_core import PydanticSerializationError
from typing import TYPE_CHECKING, List, Any, Dict, Literal, NamedTuple, Optional, Union
from collections.abc import Mapping
from dataclasses import is_dataclass, asdict, fields
from datetime import date, datetime

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from ag_ui.core import (
    Message as AGUIMessage,
    UserMessage as AGUIUserMessage,
    AssistantMessage as AGUIAssistantMessage,
    SystemMessage as AGUISystemMessage,
    ToolMessage as AGUIToolMessage,
    ReasoningMessage as AGUIReasoningMessage,
    ToolCall as AGUIToolCall,
    FunctionCall as AGUIFunctionCall,
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    InputContentDataSource,
    InputContentUrlSource,
)
from .types import State, SchemaKeys, LangGraphReasoning

if TYPE_CHECKING:  # pragma: no cover - typing only
    # `PartSource` is 1.0's name for a media part's source union, and since the
    # `file` arm landed it is WIDER than the two classes imported above.
    # Imported under TYPE_CHECKING rather than at runtime for the same reason
    # `BinaryInputContent` below is guarded: the published floor this package
    # declares does not export it yet, and a runtime import would make the
    # module uncollectable there.
    from ag_ui.core import PartSource

logger = logging.getLogger(__name__)

try:
    # The legacy binary content part left ``ag_ui.core`` in 1.0, but releases
    # before it still export the class — and consumers pinning those releases
    # PARSE into it, so the branches below reach it through isinstance(). Taking
    # the SDK's class whenever there is one keeps that recognition working;
    # shadowing it with a local twin would silently make every isinstance()
    # false and route legacy items down the wrong branch.
    from ag_ui.core import BinaryInputContent  # type: ignore[attr-defined]
except ImportError:  # pragma: no cover - depends on the installed SDK
    # 1.0 and later, where the protocol no longer knows the shape.
    #
    # This keeps the module IMPORTABLE; it does not keep the legacy path alive.
    # 1.0's ``InputContent`` is a discriminated union with no ``binary`` member,
    # so a message carrying one is rejected at ``RunAgentInput`` validation —
    # loudly, and upstream of this adapter. Nothing here can construct one
    # either, since this module only reads already-parsed models. So under 1.0
    # the two ``isinstance`` branches below are inert, and a legacy producer
    # gets a validation error rather than a conversion. Reviving that path would
    # mean normalising ``binary`` into a media part BEFORE validation, the way
    # the TypeScript client's 0.0.47 middleware does — not here.
    #
    # ``extra="allow"`` matches the base the protocol used: the wire may carry
    # members this shape does not name, and retaining them means a round trip
    # through this twin does not quietly discard them. The branches below read
    # only declared fields, so nothing here depends on it today.
    class BinaryInputContent(BaseModel):
        """The legacy binary content part, retired from ``ag_ui.core`` in 1.0."""

        model_config = ConfigDict(
            extra="allow",
            populate_by_name=True,
            alias_generator=to_camel,
        )

        type: Literal["binary"] = "binary"
        mime_type: str
        id: Optional[str] = None
        url: Optional[str] = None
        data: Optional[str] = None
        filename: Optional[str] = None

        @model_validator(mode="after")
        def validate_source(self) -> "BinaryInputContent":
            """Ensure at least one binary payload source is provided."""
            if not any([self.id, self.url, self.data]):
                raise ValueError("BinaryInputContent requires id, url, or data to be provided.")
            return self


# Type alias for the AG-UI multimodal content union
AGUIContentItem = Union[
    TextInputContent,
    ImageInputContent,
    AudioInputContent,
    VideoInputContent,
    DocumentInputContent,
    BinaryInputContent,
]

DEFAULT_SCHEMA_KEYS = ["tools"]

def filter_object_by_schema_keys(obj: Dict[str, Any], schema_keys: List[str]) -> Dict[str, Any]:
    if not obj:
        return {}
    return {k: v for k, v in obj.items() if k in schema_keys}

def get_stream_payload_input(
    *,
    mode: str,
    state: State,
    schema_keys: SchemaKeys,
) -> Union[State, None]:
    input_payload = state if mode == "start" else None
    if input_payload and schema_keys and schema_keys.get("input"):
        input_payload = filter_object_by_schema_keys(input_payload, [*DEFAULT_SCHEMA_KEYS, *schema_keys["input"]])
    return input_payload

def stringify_if_needed(item: Any) -> str:
    if item is None:
        return ''
    if isinstance(item, str):
        return item
    return json.dumps(item)

# Standard media block type -> the AG-UI content class that carries it back.
#
# The return leg of `_STANDARD_BLOCK_TYPES`, and it has to exist: this converter
# builds the user message inside MESSAGES_SNAPSHOT, so a block kind missing here
# is an attachment that vanishes from the thread on the next snapshot — the file
# was sent, the model read it, and a reopened thread shows a bare line of text.
_AGUI_MEDIA_CLASSES = {
    "audio": AudioInputContent,
    "video": VideoInputContent,
    "file": DocumentInputContent,
    "image": ImageInputContent,
}

# The AG-UI content class for each AG-UI media type, keyed by the media type
# itself rather than by the LangChain block type `_AGUI_MEDIA_CLASSES` uses.
_AGUI_CLASS_BY_MEDIA_TYPE = {
    "image": ImageInputContent,
    "audio": AudioInputContent,
    "video": VideoInputContent,
    "document": DocumentInputContent,
}

# The AG-UI media type named by a MIME type's MAJOR part. Used only on the
# `image_url` return leg — see `_agui_media_type_for_mime_type`. Kept in lockstep
# with `MEDIA_TYPES_BY_MIME_MAJOR` in the TypeScript adapter.
_MEDIA_TYPES_BY_MIME_MAJOR = {
    "image": "image",
    "audio": "audio",
    "video": "video",
}


def _agui_media_type_for_mime_type(mime_type: str) -> str:
    """Recover media types from legacy ``image_url`` data URLs in saved threads."""
    major, _, subtype = mime_type.partition("/")
    # A string that is not `major/subtype` carries no modality; keep the historical
    # answer rather than inventing a new wrong one.
    if not major or not subtype:
        return "image"
    return _MEDIA_TYPES_BY_MIME_MAJOR.get(major.strip().lower(), "document")


class _IncomingMedia(NamedTuple):
    """A media block normalized away from whichever vocabulary it arrived in."""

    value: str
    is_url: bool
    mime_type: str | None
    filename: str | None


def _first_non_empty_string(*candidates: Any) -> str | None:
    """The first candidate that is a non-empty ``str``, or ``None``.

    Every caller reads keys that arrive off the wire, where a value can be
    absent, empty, or of the wrong type entirely, and none of those three is
    usable. Both distinctions matter: falling through on the EMPTY string is what
    lets a second spelling of the same field be reached, and rejecting
    NON-STRINGS is what stops a truthy number from being handed to code that
    expects text. Mirrors TypeScript's ``firstNonEmptyString``.
    """
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _describe_type(value: Any) -> str:
    """A short name for the runtime type of an off-the-wire value, for the
    "Dropping …" logs rule 2 of the malformed-input contract requires."""
    return type(value).__name__


def _incoming_block_filename(item: Dict[str, Any]) -> str | None:
    """The attachment's original filename, wherever the sender happened to put it.

    ``metadata.filename`` is AG-UI's carrier and what the TypeScript adapter
    emits; ``metadata.name`` / ``metadata.title`` and the top-level ``filename``
    are the other spellings langchain-core's provider translators read, so a
    block that would reach OpenAI with a real filename must not lose it here.
    Losing it is not cosmetic: langchain-core's OpenAI translator warns and
    substitutes a ``LC_AUTOGENERATED`` placeholder for a nameless file block.
    """
    metadata = item.get("metadata")
    if isinstance(metadata, dict):
        for key in ("filename", "name", "title"):
            value = metadata.get(key)
            if isinstance(value, str) and value:
                return value
    filename = item.get("filename")
    if isinstance(filename, str) and filename:
        return filename
    return None


def _read_incoming_media_block(item: Dict[str, Any]) -> _IncomingMedia | None:
    """Normalize an inbound media block, whichever of three vocabularies it uses.

    DELIBERATELY ACCEPTS THREE SHAPES, because three can genuinely arrive:

      1. native LangChain.js — ``data`` / ``url``, ``mimeType``,
         ``metadata.filename``. What a JS-side graph produces.
      2. LangChain Python — ``base64`` / ``url``, ``mime_type``, top-level
         ``filename``. What this package's own outbound leg emits.
      3. the ``source_type`` family — ``source_type`` plus ``data`` / ``url``,
         ``mime_type``, ``metadata.filename``. What the TypeScript adapter emits
         on the wire, and what ``@langchain/core``'s legacy conversion path still
         accepts.

    Reading only shape 2 is what made this converter drop every base64 media
    block the TypeScript half sends. ``source_type`` itself needs no branch — it
    only announces which of ``data`` / ``url`` is populated, and both are read
    here anyway.

    Being liberal inbound and strict outbound is the point: one wire shape leaves
    this converter, three can arrive.
    """
    filename = _incoming_block_filename(item)
    # Read like the filename above: the MIME type is whatever the graph put on
    # the block, and a non-string one is not a MIME type this converter can carry
    # — AG-UI's source classes REQUIRE `str | None`, so handing one straight to
    # them raises a ValidationError that takes the whole snapshot down with it.
    # Treat it as absent instead; the data path already has a documented fallback
    # (`application/octet-stream`) for a block that arrives without one.
    mime_type = _first_non_empty_string(item.get("mimeType"), item.get("mime_type"))

    # A SCAN FOR THE FIRST NON-EMPTY STRING, not `a or b`. `or` short-circuits on
    # anything TRUTHY, so a non-string `data` — a number, a dict, `True`, all of
    # which arrive off the wire — stopped the read dead and the perfectly good
    # `base64` behind it was never reached, dropping the whole block. The
    # TypeScript reader scans (`firstNonEmptyString(item.data, item.base64)`) and
    # recovers it; this line is what made the two runtimes disagree about the
    # same inbound block.
    inline_data = _first_non_empty_string(item.get("data"), item.get("base64"))
    if inline_data:
        return _IncomingMedia(inline_data, False, mime_type, filename)

    url = _first_non_empty_string(item.get("url"))
    if url:
        # A `data:` URL is url-SHAPED but it is not a reference: RFC 2397 puts
        # the bytes in the string. Recording it as an AG-UI URL SOURCE writes a
        # claim into the thread that the attachment lives somewhere else, and the
        # outbound leg then believes it — a PDF stored this way went back out as
        # `image_url`, the exact provider failure the standard-block path exists
        # to prevent. Normalizing here rather than only outbound means the THREAD
        # is right too, which is what `MESSAGES_SNAPSHOT` shows the client and
        # what `flatten_user_content` and every other reader of AG-UI content
        # sees.
        #
        # The MIME type inside the data URL wins over the block's declared one,
        # for the reason `_inline_media_data` gives; a data URL with an omitted
        # mediatype falls back to the block's.
        #
        # A REMOTE url, and a data URL this cannot read as inline bytes (no
        # `;base64`, no comma, empty payload — see `_parse_base64_data_url`),
        # stay url sources exactly as before.
        data_url = _parse_base64_data_url(url)
        if data_url:
            return _IncomingMedia(
                data_url[1],
                False,
                data_url[0] if data_url[0] is not None else mime_type,
                filename,
            )
        return _IncomingMedia(url, True, mime_type, filename)

    # `file_id` / `fileId` / `id`-only blocks reference provider-side storage
    # with no bytes and no URL, and AG-UI's typed classes have nowhere to put
    # that.
    return None


def _incoming_image_url(payload: Any) -> str | None:
    """The url carried by a legacy ``image_url`` block, or ``None`` if it has none.

    The payload is whatever the graph put under the ``image_url`` key. Two shapes
    carry a url: LangChain's own ``{"url": "…"}`` and the bare string both
    runtimes also accept. EVERYTHING else — ``None``, a number, a list, a dict
    with no ``url`` or an empty/non-string one — carries no url at all, and the
    caller drops the block rather than deriving one.

    Reading it defensively is the point. This converter builds the user message
    inside MESSAGES_SNAPSHOT, so ``payload.startswith(...)`` on a null payload
    does not lose one block, it raises out of the whole snapshot and loses the
    ENTIRE thread. And a payload that yields ``""`` is no better for being
    quiet: it mints an attachment pointing at nothing.

    Mirrors the `item.image_url` read in the TypeScript adapter's
    `convertLangchainMultimodalToAgui`, which skips the same blocks.
    """
    url = payload if isinstance(payload, str) else None
    if url is None and isinstance(payload, dict):
        # `dict.get`, not `payload.get`, for the same reason `str.strip` is
        # spelled that way below: a dict SUBCLASS off the wire can override
        # `.get` and raise from it, and an exception here escapes the whole
        # MESSAGES_SNAPSHOT.
        candidate = dict.get(payload, "url")
        url = candidate if isinstance(candidate, str) else None
    if url is None:
        return None

    # `str.strip`, not `url.strip()`, and the reason is not style. It does two
    # jobs at once:
    #
    # 1. Whitespace is the side door into the empty-value defect this function
    #    already rejects. A url of "   " is truthy, so a bare falsiness check
    #    lets it through to mint an attachment pointing at nothing, and a
    #    LEADING space on "  data:image/png;base64,…" is worse than that: the
    #    caller's `startswith("data:")` says False, so a base64 payload is
    #    filed as a remote url the client then tries to fetch.
    # 2. It returns a plain `str` even for a `str` SUBCLASS, so every operation
    #    the caller runs downstream — startswith, split — is a built-in on a
    #    built-in. A subclass arriving off the wire cannot override its way
    #    into an exception that escapes MESSAGES_SNAPSHOT, which is rule 1 of
    #    the malformed-input contract.
    return str.strip(url) or None


def _supplied_filename(
    block_type: str, filename: str | None, mime_type: str | None
) -> str | None:
    """An inbound filename, unless this adapter is the one that made it up.

    `_derive_filename` fabricates a name for every filename-less document on the
    way out, because the provider translator needs one. That name comes back on
    the return leg, and writing it into AG-UI ``metadata.filename`` would make an
    invented name INDISTINGUISHABLE from one the user typed — the thread would
    then assert, permanently, that the user attached a file called
    ``attachment.pdf``. It also freezes the guess: a supplied name always wins
    over derivation, so once the fabricated one is in the thread, every later
    send keeps it even after the derivation is corrected.

    There is no marker to test, and a marker on the wire would be a marker in the
    provider request. What there is instead is determinism: the fabricated name
    is exactly ``_derive_filename(mime_type)`` and nothing else ever is, so
    recomputing it identifies it. A user who genuinely named their PDF
    ``attachment.pdf`` loses nothing that reaches a provider — the outbound leg
    derives that same string back for them on the next send.

    Only ``file`` blocks are checked, because only ``file`` blocks are ever given
    a derived name. Mirrors `suppliedFilename` in the TypeScript adapter.
    """
    if not filename:
        return None
    if block_type == "file" and filename == _derive_filename(mime_type):
        return None
    return filename


def _agui_media_from_standard_block(item: Dict[str, Any]):
    """Rebuild an AG-UI media content item from a LangChain standard block."""
    agui_class = _AGUI_MEDIA_CLASSES[item["type"]]
    incoming = _read_incoming_media_block(item)
    if incoming is None:
        return None

    # URL blocks never receive derived filenames, so every supplied name is real.
    filename = (
        incoming.filename if incoming.is_url
        else _supplied_filename(item["type"], incoming.filename, incoming.mime_type)
    )
    metadata = {"filename": filename} if filename else None

    if incoming.is_url:
        return agui_class(
            source=InputContentUrlSource(
                type="url",
                value=incoming.value,
                mime_type=incoming.mime_type,
            ),
            metadata=metadata,
        )

    return agui_class(
        source=InputContentDataSource(
            type="data",
            value=incoming.value,
            # A base64 block without a MIME type is malformed rather than merely
            # terse, but AG-UI's data source REQUIRES one, so fall back to the
            # least wrong thing instead of dropping the file.
            mime_type=incoming.mime_type or "application/octet-stream",
        ),
        metadata=metadata,
    )


# THE MALFORMED-INPUT CONTRACT for the two content converters below.
#
# Both directions read sequences that nothing validated at this boundary —
# LangGraph relays whatever the graph put in a message, and the AG-UI side
# arrives as client JSON — so every field reachable from here can be absent,
# empty, or of the wrong type. Three rules, and they hold for BOTH converters in
# BOTH runtimes:
#
#   1. DROP, NEVER RAISE. An item this converter cannot make sense of is
#      skipped. Nothing in either converter raises on its input. These functions
#      build a whole MESSAGES_SNAPSHOT / a whole provider request, so an
#      exception does not degrade one attachment — it escapes the loop and costs
#      the client every message in the thread.
#   2. EVERY DROP IS LOGGED, once, at warning level, in a message beginning
#      "Dropping ". A vanished attachment with no string to search for is the
#      failure an operator cannot diagnose. This covers the drops that have no
#      branch of their own: an item of an UNRECOGNISED TYPE is a drop too, and
#      says so.
#   3. ONE BAD ITEM COSTS ONLY ITSELF. The items on either side of it in the
#      same content list, and every other message in the list, still convert.
#
# All three are checkable from outside: for ANY input, each converter returns a
# list, emits one warning per dropped item, and the surviving items are exactly
# what the same input minus the bad item would have produced.
#
# The TypeScript adapter carries this same block above
# `convertLangchainMultimodalToAgui`. The two must not drift.


def convert_langchain_multimodal_to_agui(content: Union[str, List[Union[str, Dict[str, Any]]]]) -> List[AGUIContentItem]:
    """Convert LangChain's multimodal content to AG-UI format.

    Plain string entries are preserved in place as text. LangChain declares
    message content as ``str | list[str | dict]``, so a string sitting beside the
    blocks is content rather than a malformed block, and dropping it lost the
    user's words. A bare string ARGUMENT is normalized to a one-entry list as a
    defensive convenience for direct callers — a str is itself iterable, so
    walking one would shred it into a content item per character. The production
    caller (:func:`langchain_messages_to_agui`) only routes list content here and
    converts bare-string message content itself.

    ``image_url`` blocks are converted with the appropriate source type (data or
    URL) and to the media class their MIME type names. Older adapter versions
    emitted non-image media this way, so the block kind alone is not evidence
    of an image. See
    `_agui_media_type_for_mime_type`. LangChain's standard media blocks
    (``image`` / ``audio`` / ``video`` / ``file``) are converted back to the
    matching AG-UI content class, which is what keeps a non-image attachment in
    the thread across a MESSAGES_SNAPSHOT.

    Those media blocks may arrive in any of three field vocabularies — see
    :func:`_read_incoming_media_block`.

    A block this converter cannot make sense of is SKIPPED AND LOGGED, never
    raised on — see THE MALFORMED-INPUT CONTRACT above. The caller
    (`langchain_messages_to_agui`) builds the whole MESSAGES_SNAPSHOT, so an
    exception here does not degrade one attachment — it escapes the conversion
    and costs the client every message in the thread.
    """
    if isinstance(content, str):
        content = [content]
    elif not isinstance(content, list):
        # Rule 2, one level further out than the `else` at the end of this loop:
        # the whole content value, not one of its items. A dict reaching here
        # would otherwise be walked as a sequence of its own KEY NAMES.
        logger.warning(
            "Dropping content: not a str or list (%s)", _describe_type(content)
        )
        return []

    agui_content: List[AGUIContentItem] = []
    for item in content:
        if isinstance(item, str):
            agui_content.append(TextInputContent(
                type="text",
                text=item
            ))
        elif isinstance(item, dict):
            # Read ONCE, into a local. `item.get("type") in _AGUI_MEDIA_CLASSES`
            # below raises `TypeError: unhashable type` for a `type` that is a
            # list or a dict — a rule-1 violation that takes the whole snapshot
            # down — so the membership test goes through a hashable-safe guard.
            block_type = item.get("type")
            if block_type == "text":
                text = item.get("text", "")
                # `TextInputContent.text` is a `str`; a block whose `text` is
                # anything else raises a ValidationError that aborts the whole
                # message list rather than the one bad block.
                if not isinstance(text, str):
                    logger.warning(
                        "Dropping text block: text is %s, not a string",
                        type(text).__name__,
                    )
                    continue
                agui_content.append(TextInputContent(
                    type="text",
                    text=text
                ))
            elif isinstance(block_type, str) and block_type in _AGUI_MEDIA_CLASSES:
                media = _agui_media_from_standard_block(item)
                if media:
                    agui_content.append(media)
                else:
                    logger.warning(
                        "Dropping %s block: no data, base64 or url to carry back",
                        block_type,
                    )
            elif block_type == "image_url":
                url = _incoming_image_url(item.get("image_url"))
                if not url:
                    logger.warning(
                        "Dropping image_url block: no usable url in its %s payload",
                        _describe_type(item.get("image_url")),
                    )
                    continue

                # Parse data URLs to extract base64 data
                if url.startswith("data:"):
                    # Format: data:mime_type;base64,data
                    parts = url.split(",", 1)
                    header = parts[0]
                    data = parts[1] if len(parts) > 1 else ""

                    # Rule 1 and rule 2 of the malformed-input contract. A `data:`
                    # URL with no comma at all (`data:image/png;base64`) or nothing
                    # after it (`data:image/png;base64,`) has no payload, and the
                    # branch below would mint an AG-UI content item whose `value`
                    # is the EMPTY STRING — an attachment pointing at nothing,
                    # written into the thread and read back on every later open.
                    # That is the same defect `_incoming_image_url` rejects one
                    # level up for a payload that yields `""`, and the same one
                    # `_read_incoming_media_block` already rejects on the
                    # standard-block path, where an empty `data`/`base64` drops the
                    # block. This branch was the one place that kept it.
                    # No `.strip()` here, deliberately: `_incoming_image_url`
                    # already stripped the whole url, so a payload that is
                    # nothing but whitespace has ALREADY become the empty
                    # string by the time it reaches this guard. A payload with
                    # INTERNAL whitespace keeps it, which is correct —
                    # MIME-wrapped base64 legitimately carries newlines and
                    # both atob and b64decode ignore them.
                    if not data:
                        logger.warning(
                            "Dropping image_url block: data URL carries no payload"
                        )
                        continue

                    # `or "image/png"`, not just the `":" in header` gate. A
                    # `data:` URL ALWAYS has a colon, so the gate never falls
                    # through for one — but the mediatype it then extracts is the
                    # empty string for the `data:;base64,…` that a MIME-less
                    # attachment produces. The gate therefore treated "present but
                    # empty" as a value and wrote `mime_type=""` into the thread,
                    # while the docstring on `_agui_media_type_for_mime_type`
                    # claimed the `image/png` default applied to exactly this case.
                    # Now it does, which is also what the mirrored TypeScript
                    # adapter records for the same input. The MEDIA TYPE is
                    # unaffected either way — `_agui_media_type_for_mime_type`
                    # answers "image" for both "" and "image/png" — so this only
                    # stops an unusable MIME type from being recorded, it does not
                    # retype anything.
                    # The `or` guard treats a MIME-less "data:;base64,…" as
                    # absent. "data:   ;base64,…" is the same thing wearing
                    # whitespace: present-but-blank, and unusable for the same
                    # reason. Note this collapses a BLANK mediatype only — a
                    # padded but real one keeps its padding, which the
                    # cross-runtime parity table pins because the TypeScript
                    # adapter records it verbatim too.
                    raw_mime = (
                        header.split(":")[1].split(";")[0] if ":" in header else ""
                    )
                    mime_type = (raw_mime if raw_mime.strip() else "") or "image/png"

                    # The MIME type this adapter put in the data URL on the way out
                    # is enough to recover the modality on the way back.
                    agui_class = _AGUI_CLASS_BY_MEDIA_TYPE[
                        _agui_media_type_for_mime_type(mime_type)
                    ]
                    agui_content.append(agui_class(
                        source=InputContentDataSource(
                            type="data",
                            value=data,
                            mime_type=mime_type,
                        ),
                    ))
                else:
                    # Regular URL. Nothing here names a modality — this is the
                    # first of the two unrecoverable cases in
                    # `_agui_media_type_for_mime_type` — so it stays an image.
                    agui_content.append(ImageInputContent(
                        type="image",
                        source=InputContentUrlSource(
                            type="url",
                            value=url,
                        ),
                    ))
            else:
                # Rule 2 of the malformed-input contract. A block matching NO
                # branch used to fall out of the loop leaving nothing behind —
                # no content item and no log — while the docstring above claimed
                # such a block "is SKIPPED AND LOGGED". It was skipped; it was
                # never logged. That is the drop most worth announcing: the
                # others lost one field of a recognized block, this one loses the
                # attachment whole, and an operator watching a file vanish from a
                # reopened thread had no string to search for. A block kind
                # langchain-core adds later lands here.
                logger.warning(
                    "Dropping unsupported content block of type %r", block_type
                )
        else:
            # Same rule, one level out. A content list relayed by the LangGraph
            # server can carry a JSON `null`, a number, or a nested list where a
            # block is expected. `.get` on one of those would raise out of the
            # whole message list, so this loop never called it — but it said
            # nothing either. The TypeScript adapter already warns here. A bare
            # string is NOT one of these — LangChain accepts one as content, and
            # the branch at the top of the loop keeps it.
            logger.warning(
                "Dropping content block: not a dict (%s)", _describe_type(item)
            )
    return agui_content

def _reasoning_block_summary_text(block: Dict[str, Any]) -> str:
    """Extract the human-readable reasoning text from a LangChain reasoning
    content block (OpenAI Responses ``responses/v1`` shape)."""
    summary = block.get("summary")
    if isinstance(summary, list):
        # `isinstance(..., str)` and not merely truthy: a summary part whose
        # `text` is a dict or a number joins into a `TypeError` that aborts the
        # whole snapshot, so a part that is not text is skipped like one that is
        # empty.
        parts = [
            s["text"]
            for s in summary
            if isinstance(s, dict) and isinstance(s.get("text"), str) and s["text"]
        ]
        if parts:
            # Join multi-part summaries with a newline so the parts stay
            # legible instead of being mashed together ("A\nB", not "AB").
            return "\n".join(parts)
    # Fallbacks for non-OpenAI shapes that still carry a flat text field.
    for key in ("reasoning", "text"):
        val = block.get(key)
        if isinstance(val, str) and val:
            return val
    return ""


def _reasoning_block_to_agui_message(
    block: Dict[str, Any], assistant_id: str, index: int = 0
) -> "AGUIReasoningMessage | None":
    """Turn a LangChain reasoning content block into an AG-UI
    ReasoningMessage, preserving the block id (so it round-trips back to the
    provider as the same reasoning item) and any encrypted content (needed when
    the provider is run statelessly with ``store=False``).

    Returns ``None`` for a block with neither text nor encrypted content — there
    is nothing the client could render or round-trip.
    """
    text = _reasoning_block_summary_text(block)
    # `ReasoningMessage.encrypted_value` is `str | None`; a block whose
    # `encrypted_content` is anything else has nothing round-trippable in it and
    # would raise a ValidationError that costs the whole snapshot, not one block.
    encrypted = block.get("encrypted_content")
    if not isinstance(encrypted, str) or not encrypted:
        encrypted = None
    block_id = block.get("id")
    # The provider id (e.g. OpenAI ``rs_…``) is the round-trip handle: under
    # ``store=True`` the summary/encrypted content are empty and the id alone is
    # what lets the next request reference the stored reasoning. So emit whenever
    # we have an id, text, or encrypted content; only a wholly empty block is
    # dropped (nothing to render or round-trip).
    if not block_id and not text and not encrypted:
        return None
    # Fall back to a deterministic id derived from the owning assistant message
    # when the provider didn't supply one. Include the block index so multiple
    # id-less reasoning blocks on one message don't collide on the same id.
    block_id = block_id or f"{assistant_id}-reasoning-{index}"
    return AGUIReasoningMessage(
        id=str(block_id),
        role="reasoning",
        content=text,
        encrypted_value=encrypted,
    )


def _agui_reasoning_message_to_block(message: AGUIReasoningMessage) -> Dict[str, Any]:
    """Rebuild the LangChain reasoning content block from an AG-UI
    ReasoningMessage so it can be re-attached to the adjacent assistant message
    (the inverse of :func:`_reasoning_block_to_agui_message`)."""
    block: Dict[str, Any] = {
        "type": "reasoning",
        "id": message.id,
        "summary": (
            [{"type": "summary_text", "text": message.content}]
            if message.content
            else []
        ),
    }
    if getattr(message, "encrypted_value", None):
        block["encrypted_content"] = message.encrypted_value
    return block


def langchain_messages_to_agui(messages: List[BaseMessage]) -> List[AGUIMessage]:
    agui_messages: List[AGUIMessage] = []
    for message in messages:
        if isinstance(message, HumanMessage):
            # Handle multimodal content
            if isinstance(message.content, list):
                content = convert_langchain_multimodal_to_agui(message.content)
            else:
                content = stringify_if_needed(resolve_message_content(message.content))

            agui_messages.append(AGUIUserMessage(
                id=str(message.id),
                role="user",
                content=content,
                name=message.name,
            ))
        elif isinstance(message, AIMessage):
            # Surface reasoning content blocks as standalone
            # ReasoningMessages placed BEFORE the assistant message (matching
            # streaming-event ordering), so a client with no persistent
            # checkpoint can round-trip them back to the model.
            if isinstance(message.content, list):
                for index, block in enumerate(message.content):
                    if isinstance(block, dict) and block.get("type") == "reasoning":
                        reasoning_msg = _reasoning_block_to_agui_message(
                            block, str(message.id), index
                        )
                        if reasoning_msg is not None:
                            agui_messages.append(reasoning_msg)

            tool_calls = None
            if message.tool_calls:
                tool_calls = [
                    AGUIToolCall(
                        id=str(tc["id"]),
                        type="function",
                        function=AGUIFunctionCall(
                            name=tc["name"],
                            # `args` is `dict[str, Any]`, so a graph can put a
                            # datetime (or any object) in it and a bare
                            # `json.dumps` raises — aborting every message in the
                            # snapshot over one argument. Degrade that argument
                            # instead, with the encoder this module already owns.
                            arguments=json.dumps(
                                tc.get("args", {}), default=json_safe_stringify
                            ),
                        ),
                    )
                    for tc in message.tool_calls
                ]

            agui_messages.append(AGUIAssistantMessage(
                id=str(message.id),
                role="assistant",
                content=stringify_if_needed(resolve_message_content(message.content)),
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif isinstance(message, SystemMessage):
            agui_messages.append(AGUISystemMessage(
                id=str(message.id),
                role="system",
                content=stringify_if_needed(resolve_message_content(message.content)),
                name=message.name,
            ))
        elif isinstance(message, ToolMessage):
            agui_messages.append(AGUIToolMessage(
                id=str(message.id),
                role="tool",
                content=stringify_if_needed(resolve_message_content(message.content)),
                tool_call_id=message.tool_call_id,
                # A LangChain tool result signals failure only through `status`, with
                # no error text. Restore AG-UI's `error` so the failure survives the
                # round trip; the value is a fixed sentinel (#2305) because the
                # original text is not recoverable from the flag alone.
                error="error" if message.status == "error" else None,
            ))
        else:
            raise TypeError(f"Unsupported message type: {type(message)}")
    return agui_messages

_MEDIA_CONTENT_TYPES = (ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent)

# Non-image media retain their modality; provider translators decide support.
_STANDARD_BLOCK_TYPES = {
    AudioInputContent: "audio",
    VideoInputContent: "video",
    DocumentInputContent: "file",
}


def _by_content_class(table: Dict[Any, Any], item: Any, default: Any = None) -> Any:
    """Look a content item up in a per-class table BY `isinstance`.

    Every one of these tables sits behind an `isinstance` gate — the media branch
    of the two loops below is entered with `isinstance(item, _MEDIA_CONTENT_TYPES)`
    — so resolving the row with `table[type(item)]` asks the same question by a
    STRICTER rule, and the two answers diverge for exactly the inputs the gate was
    written to accept. An application that subclasses `DocumentInputContent` to
    hang its own fields off an attachment passed the gate, missed the exact-class
    lookup, and had its PDF emitted as `image_url` — the provider 400 ("Invalid
    MIME type. Only image types are supported") this whole path exists to avoid.

    Admission and resolution now use one rule, so a subclass is routed as
    whatever it IS. Rows are tried in insertion order; the content classes are
    siblings, so at most one can ever match.
    """
    for content_class, value in table.items():
        if isinstance(item, content_class):
            return value
    return default


# Preserve established normalization for WAV/MP3 aliases on inline audio.
_OPENAI_AUDIO_MIME_TYPES = {
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/mp3": "audio/mp3",
    "audio/mpeg": "audio/mp3",
}


def _parse_base64_data_url(value: Any) -> tuple[str | None, str] | None:
    """The ``(mime_type, base64_payload)`` inside a ``data:`` URL, or ``None``.

    A ``data:`` URL carries inline bytes even when its source is labelled URL.
    Its MIME type describes the payload and takes precedence over source metadata.

    WHAT COUNTS. Only ``data:[<mediatype>][;…];base64,<non-empty payload>``.
    Three near-misses are deliberately NOT read as inline data, and each one falls
    through to the caller's pre-existing url handling rather than being guessed
    at:

      1. NO ``;base64`` PARAMETER (``data:text/plain,hello``). RFC 2397's default
         encoding is percent-encoded text, not base64. The standard media block's
         payload key is base64 BY DEFINITION — both translators feed it straight
         into ``data:<mime>;base64,…`` — so putting percent-encoded text there
         would hand the provider a payload that decodes to garbage. Preserve
         the original URL instead.
      2. NO COMMA (``data:application/pdf;base64``) — not a data URL at all,
         there is no payload delimiter.
      3. AN EMPTY PAYLOAD (``data:application/pdf;base64,``). Same rule the
         inbound ``image_url`` branch already applies: a block whose payload is
         the empty string is an attachment pointing at nothing.

    ``startswith("data:")`` is CASE-SENSITIVE, matching the ``image_url`` branch
    of `convert_langchain_multimodal_to_agui` byte for byte. URI schemes are
    case-insensitive per RFC 3986 §3.1, so ``DATA:`` is a legal spelling this
    declines — but this file already declined it in the one place it looked for a
    data URL, and one rule applied everywhere is worth more here than a second,
    better rule applied in one place. The ``;base64`` parameter itself IS matched
    case-insensitively, because RFC 2045 §6.1 makes the encoding token
    case-insensitive and ``;Base64`` occurs in the wild.

    Mirrors `parseBase64DataUrl` in the TypeScript adapter.
    """
    # Read through the same helper as every other off-the-wire string in this
    # file: a non-string `url` reaches both call sites (an inbound block relayed
    # by the graph, an AG-UI source built without validation), and `.startswith`
    # on one raises out of the loop that converts the whole message list — rule 1
    # of THE MALFORMED-INPUT CONTRACT.
    url = _first_non_empty_string(value)
    if not url or not url.startswith("data:"):
        return None

    # Split on the FIRST comma and keep everything after it, matching the
    # `image_url` branch: base64 has no commas, but a payload that carries one
    # must not be silently truncated.
    header, separator, data = url.partition(",")
    if not separator or not data:
        return None

    parameters = header[len("data:"):].split(";")
    # Scanning the parameters rather than testing the last one: `;base64` is
    # documented as trailing, but `data:audio/wav;codecs=1;base64,…` is a shape
    # this can be handed and the encoding is still base64.
    if not any(parameter.strip().lower() == "base64" for parameter in parameters[1:]):
        return None
    return (_first_non_empty_string(parameters[0].strip()), data)


def _is_provider_file_source(source: Any) -> bool:
    """True for AG-UI's ``file`` part source.

    ``PartSource``'s third arm names bytes that ALREADY LIVE AT A PROVIDER,
    under a handle that provider issued (an OpenAI/Anthropic file id, a Gemini
    file URI). No bytes travel with one and nothing may fetch it: ``value`` is
    opaque and is expressly NOT a URL, so it must never reach ``image_url``.

    Matched by its ``type`` DISCRIMINATOR rather than by ``isinstance`` against
    ``ag_ui.core.FileSource``, for the reason the TYPE_CHECKING import at the
    top gives: that class is absent from the published floor this package
    declares, and the declared-floor lane installs exactly that. The
    discriminator is the part of the shape the spec fixes.
    """
    return getattr(source, "type", None) == "file"


def _inline_media_data(source: "PartSource") -> tuple[str, Any] | None:
    """Resolve inline bytes, preferring a data URL's MIME over source metadata."""
    if isinstance(source, InputContentDataSource):
        value = _first_non_empty_string(source.value)
        return (value, source.mime_type) if value else None
    if isinstance(source, InputContentUrlSource):
        parsed = _parse_base64_data_url(source.value)
        if parsed:
            return (parsed[1], parsed[0] if parsed[0] is not None else source.mime_type)
    return None


def _normalized_audio_mime_type(mime_type: Any) -> str | None:
    """Normalize established WAV/MP3 aliases; other formats return ``None``."""
    # Parameters (`;codecs=…`, `;charset=…`) are part of a legal MIME type but not
    # part of its identity, and this runtime's translator would forward them into
    # the `format` enum verbatim.
    base = (_first_non_empty_string(mime_type) or "").split(";")[0].strip().lower()
    return _OPENAI_AUDIO_MIME_TYPES.get(base)


def _standard_block_for(block_type: str | None, mime_type: Any) -> tuple[str, str | None] | None:
    """Resolve an inline block's MIME without restricting provider capabilities."""
    if block_type is None:
        return None
    resolved = _first_non_empty_string(mime_type) or "application/octet-stream"
    if block_type == "audio":
        resolved = _normalized_audio_mime_type(mime_type) or resolved
    return (block_type, resolved)


def _media_source_to_url(source: "PartSource") -> str | None:
    """Convert an InputContentDataSource or InputContentUrlSource to a URL string.

    For data sources, constructs a ``data:<mime>;base64,<value>`` URL.
    For URL sources, returns the URL directly.

    A MIME-less data source becomes ``data:;base64,…`` — an omitted mediatype —
    measured 2026-08-25. "MIME-less" here covers all three spellings of it:
    AG-UI declares `InputContentDataSource.mime_type` as a required ``str``, so
    pydantic rejects ``None`` and a non-string at construction, but a source built
    AROUND validation with ``model_construct`` carries whatever it was given, and
    interpolating that renders the literal text ``data:None;base64,…`` /
    ``data:42;base64,…`` — a media type the client never sent, which the return
    leg then records in the thread. Reading it through `_first_non_empty_string`
    collapses all three onto the omitted mediatype the data URL grammar already
    has, which is what the mirrored TypeScript adapter produces for the same
    input. Deliberately NOT the
    ``application/octet-stream`` that
    `_standard_block_for` substitutes for non-image inline media. Images still
    use this URL path, and `_agui_media_type_for_mime_type` reads the MIME type from the
    URL to recover that modality: ``application/octet-stream`` reads back as a
    DOCUMENT, so substituting it here would silently retype a MIME-less image as a
    document on the next MESSAGES_SNAPSHOT. An omitted mediatype reads back as an
    image, which is what the item already was.

    THE PAYLOAD IS READ THROUGH `_first_non_empty_string` ON BOTH SOURCE KINDS,
    for the same reason the MIME type beside it already is, and through the same
    validation-bypassing routes (`_inline_media_data` lists them):

      * a ``data`` source carrying ``None`` / ``42`` / ``""`` was interpolated
        STRAIGHT INTO the data URL — ``data:image/png;base64,None`` is a payload
        the provider will try to decode, and the empty-payload spelling
        ``data:image/png;base64,`` is the exact string `_parse_base64_data_url`
        refuses to read back as bytes, so the attachment was already unreadable by
        this adapter's own rule. It also DIVERGED on prose: this runtime wrote
        ``None`` where the TypeScript adapter wrote ``null``.
      * a ``url`` source carrying a non-string was returned VERBATIM, putting a
        number or a dict under ``image_url.url`` on the provider request. That one
        diverged on OUTCOME: ``{}`` is falsy here and truthy in TypeScript, so the
        same item was dropped by one runtime and kept by the other.

    Both collapse onto ``None``, which is the one thing the caller already knows
    how to announce.
    """
    if isinstance(source, InputContentDataSource):
        value = _first_non_empty_string(source.value)
        if not value:
            return None
        return f"data:{_first_non_empty_string(source.mime_type) or ''};base64,{value}"
    if isinstance(source, InputContentUrlSource):
        return _first_non_empty_string(source.value)
    return None


def _filename_from_metadata(metadata: Any) -> str | None:
    """The attachment's original filename, if the client sent one.

    `metadata: {filename}` is the established AG-UI carrier for it — the client's
    own `backward-compatibility-0-0-47` middleware migrates the legacy
    `BinaryInputContent.filename` into exactly that shape.

    It is worth reading back because a file block without a filename is degraded
    in both runtimes: measured 2026-08-25, langchain-core 1.2.13 warns and sends
    the placeholder ``filename: "LC_AUTOGENERATED"`` (it does NOT drop the key —
    the provider is told a wrong name rather than none), and the mirrored
    TypeScript adapter's translator (`@langchain/openai` 1.2.0) THROWS outright.
    See `_derive_filename`. Note this reads ONE key out of metadata rather than
    copying the object: a top-level `metadata` key on the block itself is what
    issue #2100 was about, and `filename` is a documented field of the block.
    """
    if isinstance(metadata, dict):
        filename = metadata.get("filename")
        if isinstance(filename, str) and filename:
            return filename
    return None


# The file extension for a MIME type whose SUBTYPE IS NOT ITS EXTENSION.
#
# Only these need an entry. A subtype that already is the extension —
# `application/pdf`, `text/csv`, `application/json`, `text/html`,
# `application/zip`, `image/png` — falls through to the derivation in
# `_derive_filename` and comes out right without being listed, so listing it
# would only be a second place to keep correct.
#
# Scope is "what an attachment realistically arrives as": office documents, the
# plain-text family, and the audio/image/video types whose subtype is a famous
# mismatch (`audio/mpeg` is mp3, `image/jpeg` is jpg). Deliberately NOT covered,
# because the generic fallback already answers them or because no answer is
# better than a guessed one: archive and compression formats beyond their own
# subtype, `application/x-*` experimental types, and unregistered vendor types
# outside the office suites.
#
# KEPT IN LOCKSTEP with `FILENAME_EXTENSIONS` in the TypeScript adapter's
# `utils.ts`. A row here that is missing there is an attachment that reaches the
# provider under two different names depending on which runtime sent it.
_FILENAME_EXTENSIONS = {
    # Text
    "text/plain": "txt",
    "text/markdown": "md",
    "text/x-markdown": "md",
    "text/rtf": "rtf",
    "application/rtf": "rtf",
    "text/xml": "xml",
    "application/xml": "xml",
    # Office
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.oasis.opendocument.text": "odt",
    "application/vnd.oasis.opendocument.spreadsheet": "ods",
    "application/vnd.oasis.opendocument.presentation": "odp",
    # The canonical "unknown bytes" type, and the generic fallback's answer too.
    "application/octet-stream": "bin",
    # Audio. Reachable here only via a document item carrying an audio MIME type
    # — the audio path emits an `audio` block, which needs no filename — but the
    # two derivations must not disagree about what `audio/mpeg` is called.
    "audio/mpeg": "mp3",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/vnd.wave": "wav",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    # Image / video, same "mislabelled document" reachability.
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "video/quicktime": "mov",
    "video/x-msvideo": "avi",
    "video/x-matroska": "mkv",
}

# An extension a filename can plausibly end in: short and alphanumeric.
# `fullmatch`, not `match`: Python's `$` also matches before a trailing newline,
# which JavaScript's does not, and the two runtimes must agree on every input.
_PLAUSIBLE_EXTENSION = re.compile(r"[a-z0-9]{1,8}")

# A MIME registration tree is a namespace, not part of any extension.
_REGISTRATION_TREE = re.compile(r"^(?:vnd\.|prs\.|x-|x\.)")


def _derive_filename(mime_type: str | None) -> str:
    """A filename for a `file` block whose AG-UI item did not carry one.

    Not cosmetic. `@langchain/openai` THROWS on a file block with no filename
    ("a filename or name or title is needed via meta-data for OpenAI when working
    with multimodal blocks" — measured 2026-08-25 on `@langchain/openai` 1.2.0),
    so the document path has to carry one for the claimed support to be real.

    langchain-core does not throw, and does not merely drop the key either:
    measured on 1.2.13, a nameless file block warns ("OpenAI may require a
    filename for file uploads…") and the part goes out carrying the PLACEHOLDER
    ``filename: "LC_AUTOGENERATED"`` — i.e. the provider is told the user attached
    a file by that name. Substituting a derived name is an improvement on both.

    The two runtimes do NOT emit the same block: this one emits ``base64`` /
    ``mime_type`` / top-level ``filename``, the TypeScript adapter emits
    ``source_type`` / ``data`` / ``mime_type`` / ``metadata.filename``. Both run
    the same derivation — `deriveFilename` there is kept identical to this — so
    an attachment gets the same name whichever runtime sent it.

    THE TWO BLOCKS ARE NOT INTERCHANGEABLE. An earlier revision of this paragraph
    said they were — "both translate to the same provider part (verified through
    both real translators)" — and only three of the four combinations hold.
    Measured 2026-08-25 with an ``application/pdf`` file block, on langchain-core
    1.2.13 (through `convert_to_openai_messages`) and `@langchain/openai` 1.2.0 +
    `@langchain/core` 1.1.40 (through `ChatOpenAI` with a stub `fetch`):

      block emitted by     Python translator      JS translator
      -------------------  ---------------------  ---------------------------
      this adapter         file.file_data ✓       FORWARDED VERBATIM ✗
                           + file.filename        (reaches the provider as
                                                  ``{"type": "file", "base64":
                                                  …, "mime_type": …,
                                                  "filename": …}``, with no
                                                  throw and no warning)
      the TypeScript one   file.file_data ✓       file.file_data ✓
                           + file.filename        + file.filename

    The failing cell is the direction that does not occur. JS gates translation on
    ``isDataContentBlock``, which tests ``source_type`` and nothing else, and this
    adapter never emits that key. It stays LATENT because neither adapter's output
    crosses into the other's translator, and for asymmetric reasons:

      * `LangGraphAgent` here takes an IN-PROCESS ``CompiledStateGraph``, not a
        remote deployment, so a block this function builds is only ever handed to
        langchain-core Python — the ✓ cell on row 1. Nothing in either package
        routes row 1 into the JS column.
      * The TypeScript adapter drives a LangGraph SERVER over
        `@langchain/langgraph-sdk`, and that server is usually the Python one, so
        ITS block does have to translate in both columns — which is why it emits
        the ``source_type`` family and why row 2 is measured in both.

    So the surviving claim is the narrower one: each block produces the same
    provider part through the translator its own runtime actually reaches, and the
    TypeScript adapter's block additionally survives this one. Revisit if this
    adapter ever grows a remote-server transport.

    THE SUBTYPE IS NOT THE EXTENSION. It coincides with one often enough to look
    like a rule — ``application/pdf``, ``text/csv`` — and then does not:
    ``text/plain`` is not ``.plain``, ``audio/mpeg`` is not ``.mpeg``, and
    ``application/vnd.api+json`` is not ``.vnd.api``. So the subtype is a LAST
    resort here, taken only when it survives being checked:

      1. `_FILENAME_EXTENSIONS` answers the types whose subtype is wrong.
      2. A structured-syntax suffix (RFC 6838 §4.2.8) names the underlying
         format, so ``+json`` / ``+xml`` wins over the vendor tree in front of it.
      3. Otherwise the registration-tree prefix (``vnd.``, ``prs.``, ``x-``,
         ``x.``) is stripped, because it is a namespace, not an extension.
      4. What is left has to LOOK like an extension. ``ms-excel`` and
         ``openxmlformats-officedocument.wordprocessingml.document`` do not, and
         a dot inside the "extension" turns ``attachment.vnd.ms-excel`` into a
         file apparently named ``attachment.vnd``. Anything implausible becomes
         ``.bin``, which is what an unidentified byte stream is called.

    MIME types are case-insensitive (RFC 2045 §5.1), so the lookup is case-folded.

    NO non-string guard here, unlike `_normalized_audio_mime_type`, and that is
    load-bearing rather than an oversight: ``str | None`` is ENFORCED for every
    caller by the two functions that resolve a MIME type before this one is
    reached — `_standard_block_for` substitutes for an unusable one and
    `_read_incoming_media_block` reads it through `_first_non_empty_string`. The
    TypeScript `deriveFilename` is guarded by the same two, so the pair agrees.
    Widen this signature and the guard has to come with it.
    """
    base = (mime_type or "").split(";")[0].strip().lower()

    extension = _FILENAME_EXTENSIONS.get(base)
    if not extension:
        _, _, subtype = base.partition("/")
        if "+" in subtype:
            subtype = subtype.rpartition("+")[2]
        else:
            subtype = _REGISTRATION_TREE.sub("", subtype)
        extension = subtype if _PLAUSIBLE_EXTENSION.fullmatch(subtype) else "bin"

    return f"attachment.{extension}"


def _standard_media_block(
    block_type: str,
    data: str,
    mime_type: str | None,
    filename: str | None = None,
) -> Dict[str, Any]:
    """Build a standard inline media block, deriving filenames only for files."""
    block: Dict[str, Any] = {
        "type": block_type,
        "base64": data,
        "mime_type": mime_type,
    }
    name = filename or (_derive_filename(mime_type) if block_type == "file" else None)
    if name:
        block["filename"] = name
    return block


def convert_agui_multimodal_to_langchain(content: List[AGUIContentItem]) -> List[Dict[str, Any]]:
    """Preserve media modality in LangChain blocks, retaining the image URL path.

    WAV/MP3 aliases retain their established normalization. Provider support is
    decided downstream; unsupported media must not masquerade as images.
    Malformed inputs retain the per-item skip-and-warn contract.
    """
    langchain_content: List[Dict[str, Any]] = []
    for item in content:
        if isinstance(item, TextInputContent):
            langchain_content.append({
                "type": "text",
                "text": item.text
            })
        elif isinstance(item, _MEDIA_CONTENT_TYPES):
            # A provider file handle is dropped, not forwarded and not raised
            # on. Inline bytes and URL references cannot carry an opaque handle,
            # and routing it to a provider-specific file
            # block is a separate decision 1.0 does not make. The spec's rule
            # for a part a producer cannot use is to skip it and warn.
            #
            # Announced on its own line rather than through the generic drop
            # below, whose "could not be converted to URL" would read as a
            # malformed source when this one is perfectly well formed and simply
            # not ours to resolve. Named by WIRE TYPE for the reason that branch
            # gives.
            if _is_provider_file_source(item.source):
                logger.warning(
                    "Dropping %s content: a provider file handle cannot be "
                    "forwarded by the LangGraph adapter",
                    getattr(item, "type", type(item).__name__),
                )
                continue
            block_type = _by_content_class(_STANDARD_BLOCK_TYPES, item)
            # A data URL carries inline bytes even when its source says URL.
            inline = _inline_media_data(item.source) if block_type else None
            if inline:
                standard = _standard_block_for(block_type, inline[1])
                if standard:
                    langchain_content.append(
                        _standard_media_block(
                            standard[0],
                            inline[0],
                            standard[1],
                            _filename_from_metadata(item.metadata),
                        )
                    )
                    continue
            url = _media_source_to_url(item.source)
            if url:
                if block_type:
                    block = {"type": block_type, "source_type": "url", "url": url}
                    mime_type = _first_non_empty_string(getattr(item.source, "mime_type", None))
                    filename = _filename_from_metadata(item.metadata)
                    if mime_type:
                        block["mime_type"] = mime_type
                    if filename:
                        block["filename"] = filename
                    langchain_content.append(block)
                else:
                    langchain_content.append({"type": "image_url", "image_url": {"url": url}})
            else:
                # Named by its WIRE TYPE (`image`, `audio`, `video`,
                # `document`), not by `type(item).__name__`. The class answers to
                # two names — 1.0 renamed these parts and kept the old names as
                # aliases of the same classes — so the class name in this line
                # reported which ag-ui-protocol the operator happened to have
                # installed, and an operator grepping for the part they sent
                # found nothing. The wire type is the name they used. It is also
                # what the mirrored TypeScript branch already logs, so the two
                # runtimes now emit the same line.
                logger.warning(
                    "Dropping %s content: source could not be converted to URL",
                    getattr(item, "type", type(item).__name__),
                )
        elif isinstance(item, BinaryInputContent):
            # Legacy items infer modality from MIME; id-only references stay unchanged.
            declared_mime_type = _first_non_empty_string(getattr(item, "mime_type", None)) or ""
            # The three payload keys, read through the SAME helper as the MIME
            # type above and for the same reason: `url` / `data` / `id` are
            # declared `str` and `BinaryInputContent` refuses a non-string at the
            # boundary, but only for an item that went THROUGH validation — the
            # four unvalidated routes named on the guard at the bottom of this
            # branch reach here carrying whatever they were given, and each key is
            # emitted VERBATIM below (`image_url: {"url": 42}` on the provider
            # request, or `data:image/png;base64,42` built out of an int). An
            # unusable payload is an ABSENT payload, so a `url` of `42` no longer
            # outranks a usable `data`, and an item whose three keys are all
            # unusable falls into that guard and is dropped with the warning it
            # already emits. The mirrored TypeScript branch reads the same three
            # keys the same way.
            supplied_url = _first_non_empty_string(item.url)
            supplied_data = _first_non_empty_string(item.data)
            supplied_id = _first_non_empty_string(item.id)
            # A legacy item's `url` is a source classification point too, and a
            # `data:` URL sitting in it is the same defect the typed path above
            # has: bytes, labelled as a reference, sent to the provider as
            # `image_url`. Resolved here so the ONE data-URL rule covers both
            # entry points.
            #
            # The url is inspected FIRST and its mediatype wins, because `url`
            # already outranks `data` in the reference form built below — this
            # branch must not promote one payload while the fallback would have
            # sent the other.
            inline_url = _parse_base64_data_url(supplied_url)
            if inline_url:
                inline_value = inline_url[1]
                mime_type = (
                    inline_url[0] if inline_url[0] is not None else declared_mime_type
                )
            else:
                inline_value = None if supplied_url else supplied_data
                mime_type = declared_mime_type
            # Modality is read off a case-folded copy: MIME types are
            # case-insensitive (RFC 2045 §5.1), so `AUDIO/WAV` names the same
            # modality as `audio/wav` and must not be routed as a document. The
            # ORIGINAL string is what gets emitted for documents, where it is
            # carried inside a data URL rather than matched against an enum.
            modality = mime_type.split(";")[0].strip().lower()
            if (
                inline_value
                and mime_type
                and not modality.startswith("image/")
            ):
                block_type = (
                    "audio" if modality.startswith("audio/")
                    else "video" if modality.startswith("video/")
                    else "file"
                )
                standard = _standard_block_for(block_type, mime_type)
                if standard:
                    langchain_content.append(
                        _standard_media_block(
                            standard[0], inline_value, standard[1], item.filename
                        )
                    )
                    continue

            if supplied_url and mime_type and not modality.startswith("image/"):
                block_type = (
                    "audio" if modality.startswith("audio/")
                    else "video" if modality.startswith("video/")
                    else "file"
                )
                block = {
                    "type": block_type,
                    "source_type": "url",
                    "url": supplied_url,
                    "mime_type": mime_type,
                }
                filename = _first_non_empty_string(item.filename)
                if filename:
                    block["filename"] = filename
                langchain_content.append(block)
                continue

            content_dict: Dict[str, Any] = {"type": "image_url"}

            # Prioritize url, then data, then id
            if supplied_url:
                content_dict["image_url"] = {"url": supplied_url}
            elif supplied_data:
                # Construct data URL from base64 data. The NORMALIZED `mime_type`
                # local, not `item.mime_type`: the raw one is optional on a legacy
                # binary item, and interpolating an absent or non-string one writes
                # the literal text `None` / `42` into the data URL as the media
                # type — which the return leg then records in the thread. Same
                # collapse as `_media_source_to_url`, and the same line the
                # TypeScript adapter already reads from its normalized local.
                content_dict["image_url"] = {"url": f"data:{mime_type};base64,{supplied_data}"}
            elif supplied_id:
                # Use id as a reference (some providers may support this)
                content_dict["image_url"] = {"url": supplied_id}
            else:
                # NOT dead code, though it looks it: `BinaryInputContent` carries
                # a pydantic `validate_source` model validator that refuses an
                # item with no `id`, `url` OR `data`, which rules this branch out
                # for anything that arrives VALIDATED. Measured 2026-08-25 on
                # pydantic 2.12.5 / ag-ui-protocol 0.1.19 — every validated route
                # (the constructor, `model_validate`, `model_validate_json`, and a
                # whole `RunAgentInput` parse) raises before the item can reach
                # this loop, with empty strings refused alongside `None`.
                #
                # Four unvalidated routes DO land here, all measured: a
                # `model_construct` item; plain attribute assignment after a valid
                # construction (the model does not set `validate_assignment`, so
                # `item.url = None` sticks); `model_copy(update=…)`, which pydantic
                # documents as unvalidated; and a subclass that overrides
                # `validate_source`. Those are precisely the inputs THE
                # MALFORMED-INPUT CONTRACT declares in scope — "a model built with
                # ``model_construct`` — or any object a caller hands this converter
                # without validating" — so the guard is doing the job the contract
                # asks of it, and rule 2 requires the drop to say so.
                #
                # Those same routes are also how an item reaches here with all
                # three keys PRESENT AND UNUSABLE (`url=42`, `data=None`): the
                # three `supplied_*` locals above collapse an unusable payload
                # onto an absent one, so such an item lands in this guard instead
                # of putting `image_url: {"url": 42}` on the provider request.
                logger.warning(
                    "Dropping BinaryInputContent item: no url, data, or id provided"
                )
                continue

            langchain_content.append(content_dict)
        else:
            # An item matching NO branch used to fall out of the loop leaving
            # nothing behind — no block and no log — while every other drop in
            # this same loop says so. That is the drop most worth announcing:
            # the others lost one field of a recognized item, this one loses the
            # attachment whole, and an operator watching a file vanish from a
            # thread had no string to search for. A new content type added to the
            # AG-UI union lands here.
            logger.warning(
                "Dropping unsupported content item of type %s", type(item).__name__
            )

    return langchain_content

def agui_messages_to_langchain(messages: List[AGUIMessage]) -> List[BaseMessage]:
    langchain_messages = []
    # Reasoning AG-UI messages are display-only at the AG-UI layer, but
    # at the LangChain layer reasoning lives as a content block ON the assistant
    # AIMessage. To round-trip reasoning without loss (so a stateless client can
    # hand the model back its own chain-of-thought), buffer each reasoning message and
    # re-attach it as a content block on the assistant message that follows it
    # (matching the order reasoning is streamed: reasoning first, then text).
    # Developer messages stay dropped — they are configured on the agent itself.
    #
    # Reasoning that is NOT immediately followed by an assistant message (a
    # trailing reasoning message, or one followed by a user/tool/system message)
    # is intentionally discarded: there is no assistant to attach it to, and
    # re-materializing it as a standalone message causes exponential message
    # duplication and tool-call loops under the add_messages reducer. The
    # snapshot side (langchain_messages_to_agui) only ever emits reasoning
    # immediately before its assistant, so this drop never affects a real
    # round-trip — only hand-crafted/ partial inputs.
    pending_reasoning: list = []
    for message in messages:
        role = message.role
        if role == "reasoning":
            pending_reasoning.append(_agui_reasoning_message_to_block(message))
            continue
        if role == "developer":
            continue
        if role == "user":
            pending_reasoning = []
            # Handle multimodal content
            if isinstance(message.content, str):
                content = message.content
            elif isinstance(message.content, list):
                content = convert_agui_multimodal_to_langchain(message.content)
            else:
                content = str(message.content)

            langchain_messages.append(HumanMessage(
                id=message.id,
                content=content,
                name=message.name,
            ))
        elif role == "assistant":
            tool_calls = []
            if hasattr(message, "tool_calls") and message.tool_calls:
                for tc in message.tool_calls:
                    args = {}
                    if hasattr(tc, "function") and tc.function.arguments:
                        try:
                            args = json.loads(tc.function.arguments)
                        except (json.JSONDecodeError, TypeError):
                            # `arguments` is the CLIENT's own locally-accumulated
                            # string, built up from streamed TOOL_CALL_ARGS
                            # deltas it received over a prior run — it can
                            # arrive corrupted here for reasons outside this
                            # function's control (e.g. a parallel-tool-call
                            # stream whose deltas got merged under the wrong
                            # tool_call_id, or a run stopped mid-stream leaving
                            # a truncated JSON string). Since `messages` is the
                            # client's full history replayed on every future
                            # run, raising here used to crash not just the run
                            # that produced the bad arguments but EVERY
                            # subsequent run in the same conversation — the
                            # thread became permanently unusable. Falling back
                            # to `{}` matches how this same branch already
                            # treats an empty `arguments` string (see the `and
                            # tc.function.arguments` guard above); this just
                            # extends that existing fallback to a
                            # non-empty-but-invalid one too.
                            logger.warning(
                                "Dropping unparseable tool_call arguments for %s (id=%s)",
                                tc.function.name, tc.id,
                            )
                    tool_calls.append({
                        "id": tc.id,
                        "name": tc.function.name,
                        "args": args,
                        "type": "tool_call",
                    })
            # Fold any buffered reasoning blocks onto this assistant message.
            if pending_reasoning:
                content = list(pending_reasoning)
                if message.content:
                    content.append({"type": "text", "text": message.content})
                pending_reasoning = []
            else:
                content = message.content or ""
            langchain_messages.append(AIMessage(
                id=message.id,
                content=content,
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif role == "system":
            pending_reasoning = []
            langchain_messages.append(SystemMessage(
                id=message.id,
                content=message.content,
                name=message.name,
            ))
        elif role == "tool":
            pending_reasoning = []
            langchain_messages.append(ToolMessage(
                id=message.id,
                content=message.content,
                tool_call_id=message.tool_call_id,
                # Carry the AG-UI failure signal onto LangChain's tool-result status, so a
                # client-reported tool failure is not delivered to the model as a success.
                status="error" if message.error else "success",
            ))
        else:
            raise ValueError(f"Unsupported message role: {role}")
    return langchain_messages

def _dual_get(obj: Any, key: str, default: Any = None) -> Any:
    """Fetch ``key`` from either a mapping or an attribute-bearing object.

    Chunks arrive as LangChain ``BaseMessage`` instances on most paths but
    some upstream integrations deliver raw dicts. Use this helper anywhere
    chunk shape is not guaranteed so we don't AttributeError on dicts or
    KeyError on objects."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def resolve_reasoning_content(chunk: Any) -> LangGraphReasoning | None:
    content = _dual_get(chunk, "content")
    if not content:
        # Fall through to check additional_kwargs for OpenAI legacy format
        pass

    if isinstance(content, list) and content and content[0]:
        block = content[0]
        block_type = block.get("type") if isinstance(block, dict) else None

        # Old langchain-anthropic format: { type: "thinking", thinking: "..." }
        if block_type == "thinking" and block.get("thinking"):
            result = LangGraphReasoning(
                text=block["thinking"],
                type="text",
                index=block.get("index", 0)
            )
            # Extract signature if present (Anthropic extended thinking signature)
            if block.get("signature"):
                result["signature"] = block["signature"]
            return result

        # New LangChain standardized format: { type: "reasoning", reasoning: "..." }
        if block_type == "reasoning" and block.get("reasoning"):
            return LangGraphReasoning(
                text=block["reasoning"],
                type="text",
                index=block.get("index", 0)
            )

        # AWS Bedrock Converse format: { type: "reasoning_content", reasoning_content: { text: "...", signature: "..." } }
        if block_type == "reasoning_content" and isinstance(block.get("reasoning_content"), dict):
            rc = block["reasoning_content"]
            if rc.get("text"):
                result = LangGraphReasoning(
                    text=rc["text"],
                    type="text",
                    index=rc.get("index", 0),
                )
                if rc.get("signature"):
                    result["signature"] = rc["signature"]
                return result

        # OpenAI Responses API v1 format: { type: "reasoning", summary: [{ text: "..." }] }
        #
        # The reasoning item's canonical id (OpenAI ``rs_…``) only travels on
        # text-less chunks: the `response.output_item.added` chunk
        # ({ id, summary: [] }) and — depending on the langchain-openai
        # version — the `…summary_part.added` chunk ({ id, summary:
        # [{ text: "" }] }). The `…summary_text.delta` chunks carry text but
        # no id. Surface the id carriers (instead of dropping them for having
        # no text) so the streamed reasoning message can adopt the canonical
        # id — the id the snapshot converter
        # (_reasoning_block_to_agui_message) emits for the same block;
        # handle_reasoning_event stashes the id without opening a message, so
        # summary-less (store=true) items still render nothing. Only the
        # first summary part takes the id: later parts belong to the same
        # item, and reusing its id would mint two messages with one id.
        if block_type == "reasoning" and isinstance(block.get("summary"), list):
            summaries = block["summary"]
            if not summaries and block.get("id"):
                return LangGraphReasoning(
                    type="text",
                    text="",
                    index=block.get("index", 0),
                    id=str(block["id"]),
                )
            if summaries and isinstance(summaries[0], dict):
                data = summaries[0]
                if data.get("text") or block.get("id"):
                    result = LangGraphReasoning(
                        type="text",
                        text=data.get("text") or "",
                        index=data.get("index", 0)
                    )
                    if block.get("id") and data.get("index", 0) == 0:
                        result["id"] = str(block["id"])
                    return result

        # Bedrock Converse API format: { type: "reasoning_content", reasoning_content: { type: "text", text: "..." } }
        if block_type == "reasoning_content" and isinstance(block.get("reasoning_content"), dict):
            inner = block["reasoning_content"]
            if inner.get("text"):
                return LangGraphReasoning(
                    type="text",
                    text=inner["text"],
                    index=inner.get("index", 0)
                )

    # OpenAI legacy format via additional_kwargs
    additional_kwargs = _dual_get(chunk, "additional_kwargs")
    if isinstance(additional_kwargs, dict):
        reasoning = additional_kwargs.get("reasoning", {})
        summary = reasoning.get("summary", []) if isinstance(reasoning, dict) else []
        if summary:
            data = summary[0]
            if not data or not data.get("text"):
                return None
            return LangGraphReasoning(
                type="text",
                text=data["text"],
                index=data.get("index", 0)
            )

        # DeepSeek / Qwen / xAI format: additional_kwargs.reasoning_content is a string
        reasoning_content = additional_kwargs.get("reasoning_content")
        if reasoning_content and isinstance(reasoning_content, str):
            return LangGraphReasoning(
                type="text",
                text=reasoning_content,
                index=0,
            )

    return None


def resolve_encrypted_reasoning_content(chunk: Any) -> str | None:
    """
    Resolves encrypted reasoning content from Anthropic responses.
    This handles:
    - `redacted_thinking` blocks with encrypted `data` (redacted chain-of-thought)
    """
    content = _dual_get(chunk, "content") if chunk is not None else None
    # `Mapping`, not a truthiness check: the next line dereferences
    # `content[0].get(...)`, and `list[str]` is a first-class LangChain content
    # shape, so a chunk of ["hello"] raised AttributeError straight out of a
    # function that runs per streamed chunk in `_handle_single_event` with no
    # enclosing try. Rule 1 of the malformed-input contract, on the streaming
    # leg. `Mapping` rather than `dict` because the old check accepted any
    # duck-typed mapping through `.get`, and narrowing to `dict` would silently
    # drop the mapping-backed blocks some providers return; `Mapping` still
    # excludes `str`, which is the shape that crashed. The sibling
    # `resolve_reasoning_content` already guards its own block read.
    if not isinstance(content, list) or not content or not isinstance(content[0], Mapping):
        return None

    # Anthropic redacted_thinking block: { type: "redacted_thinking", data: "..." }
    if content[0].get("type") == "redacted_thinking" and content[0].get("data"):
        return content[0]["data"]

    return None

def resolve_message_content(content: Any) -> str | None:
    # Distinguish None (absent) from "" (explicit empty delta): some
    # providers emit zero-length content during tool-call / structured-
    # output transitions, and the caller in _handle_single_event relies on
    # preserving the empty string so the delta still flows through.
    if content is None:
        return None

    if isinstance(content, str):
        return content

    if isinstance(content, list) and content:
        content_text = next((c.get("text") for c in content if isinstance(c, dict) and c.get("type") == "text"), None)
        return content_text

    return None


def _flatten_media_content(item: Union[ImageInputContent, AudioInputContent, VideoInputContent, DocumentInputContent], label: str) -> str:
    """Return a placeholder string for a typed media content item."""
    source = item.source
    if isinstance(source, InputContentUrlSource):
        return f"[{label}: {source.value}]"
    if isinstance(source, InputContentDataSource):
        return f"[{label}: {source.mime_type}]"
    return f"[{label}]"


_MEDIA_LABEL_MAP = {
    ImageInputContent: "Image",
    AudioInputContent: "Audio",
    VideoInputContent: "Video",
    DocumentInputContent: "Document",
}


def flatten_user_content(content: Any) -> str:
    """
    Flatten multimodal content into plain text.
    Used for backwards compatibility or when multimodal is not supported.
    """
    if content is None:
        return ""

    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, TextInputContent):
                if item.text:
                    parts.append(item.text)
            elif isinstance(item, _MEDIA_CONTENT_TYPES):
                label = _by_content_class(_MEDIA_LABEL_MAP, item, "Media")
                parts.append(_flatten_media_content(item, label))
            elif isinstance(item, BinaryInputContent):
                # Legacy BinaryInputContent — backwards compatibility
                if item.filename:
                    parts.append(f"[Binary content: {item.filename}]")
                elif item.url:
                    parts.append(f"[Binary content: {item.url}]")
                else:
                    parts.append(f"[Binary content: {item.mime_type}]")
        return "\n".join(parts)

    return str(content)


def normalize_tool_content(content: Any) -> str:
    """
    Normalize tool message content to a string.
    Handles the various content block formats from LangChain/LangGraph.

    Content can be:
    - A plain string
    - A list of strings or content blocks (e.g., {"type": "text", "text": "..."})
    """
    if isinstance(content, str):
        return content

    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and block.get('type') == 'text':
                parts.append(block.get('text', ''))
            else:
                parts.append(json.dumps(block))
        return ''.join(parts)

    return json.dumps(content)


# Used by run() to normalize forwarded_props keys from camelCase (JS frontend convention)
# to snake_case (Python convention). Appears isolated but is called from agent.py and
# removing it would silently break all streaming options forwarded from the frontend
# (stream_subgraphs, node_name, command.resume, etc.).
def camel_to_snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

def json_safe_stringify(o):
    """Fallback encoder used by json.dumps(default=...)."""
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    try:
        return make_json_safe(o)
    except Exception:
        return str(o)

def make_json_safe(value: Any, _seen: set[int] | None = None) -> Any:
    """
    Convert `value` into something that `json.dumps` can always handle.

    Rules (in order):
    - primitives → as-is
    - Enum → its .value (recursively made safe)
    - dict → keys & values made safe
    - list/tuple/set/frozenset → list of safe values
    - dataclasses → asdict() then recurse
    - Pydantic-style models → model_dump()/dict()/to_dict() then recurse
    - objects with __dict__ → vars(obj) then recurse
    - everything else → repr(obj)

    Cycles are detected and replaced with the string "<recursive>".
    """
    if _seen is None:
        _seen = set()

    obj_id = id(value)
    if obj_id in _seen:
        return "<recursive>"

    # --- 1. Primitives -----------------------------------------------------
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    # --- 2. Enum → use underlying value -----------------------------------
    if isinstance(value, Enum):
        return make_json_safe(value.value, _seen)

    # --- 2b. UUID → canonical string form ---------------------------------
    if isinstance(value, UUID):
        return str(value)

    # PATH-scoped cycle detection: the id is on the seen-set only while this
    # value's own subtree is being serialized, and is discarded on the way
    # out. A global seen-set treated any SHARED reference (the same dict
    # legitimately appearing twice — a DAG, not a cycle) as recursion; a
    # langgraph 1.2.x interrupt payload carries exactly such sharing, and its
    # second appearance serialized as the string "<recursive>", which crashed
    # the dojo's interrupt renderer ('airline' in "<recursive>").
    _seen.add(obj_id)
    try:
        # --- 3. Dicts ------------------------------------------------------
        if isinstance(value, dict):
            # LangGraph/LangChain tool calls inject non-serializable runtime/config; skip them.
            return {
                make_json_safe(k, _seen): make_json_safe(v, _seen)
                for k, v in value.items()
                if k not in ("runtime", "config")
            }

        # --- 4. Iterable containers ----------------------------------------
        if isinstance(value, (list, tuple, set, frozenset)):
            return [make_json_safe(v, _seen) for v in value]

        # --- 5. Dataclasses --------------------------------------------------
        if is_dataclass(value):
            # Skip runtime/config (LangGraph-injected, not serializable)
            d = {f.name: getattr(value, f.name) for f in fields(value) if f.name not in ("runtime", "config")}
            return make_json_safe(d, _seen)

        # --- 6. Pydantic-like models (v2: model_dump) -----------------------
        if hasattr(value, "model_dump") and callable(getattr(value, "model_dump")):
            try:
                return make_json_safe(value.model_dump(), _seen)
            except Exception:
                # fall through to other options
                pass

        # --- 7. Pydantic v1-style / other libs with .dict() -----------------
        if hasattr(value, "dict") and callable(getattr(value, "dict")):
            try:
                return make_json_safe(value.dict(), _seen)
            except Exception:
                pass

        # --- 8. Generic "to_dict" pattern -----------------------------------
        if hasattr(value, "to_dict") and callable(getattr(value, "to_dict")):
            try:
                return make_json_safe(value.to_dict(), _seen)
            except Exception:
                pass

        # --- 9. Generic Python objects with __dict__ ------------------------
        if hasattr(value, "__dict__"):
            try:
                return make_json_safe(vars(value), _seen)
            except Exception:
                pass

        # --- 10. Last resort -------------------------------------------------
        return repr(value)
    finally:
        _seen.discard(obj_id)
