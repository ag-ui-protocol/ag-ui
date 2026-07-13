"""Engine layer — the per-direction translation logic.

Advanced use only: subclass an engine to customize a single mapping and
inject it into the public translator via inbound_cls / outbound_cls. For
everything else, import AGUITranslator from the package root instead.
"""

from __future__ import annotations

from .agui_to_openai import AGUIToOpenAITranslator, ClientToolPending
from .helpers import (
    coerce_to_str,
    new_message_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
)
from .openai_to_agui import OpenAIToAGUITranslator
from .stream_types import (
    HOSTED_TOOL_CALL_TYPES,
    RawResponseEventType,
    OpenAIItemType,
    OpenAIStreamEventType,
)
from .types import TranslatedInput

__all__ = [
    # Engine translators
    "AGUIToOpenAITranslator",
    "OpenAIToAGUITranslator",
    # Result types
    "TranslatedInput",
    # Wire discriminators
    "OpenAIStreamEventType",
    "RawResponseEventType",
    "OpenAIItemType",
    "HOSTED_TOOL_CALL_TYPES",
    # Sentinels
    "ClientToolPending",
    # Shared helpers
    "new_message_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "read_attr",
    "coerce_to_str",
]
