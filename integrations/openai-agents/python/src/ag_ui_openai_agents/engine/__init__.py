"""Engine layer — the per-direction translation logic.

Advanced use only: subclass an engine to customize a single mapping and
inject it into a public translator via inbound_cls / outbound_cls. For everything
else, import the translators from the package root instead (AGUITranslator,
AGUINonStreamingTranslator).
"""

from __future__ import annotations

from .agui_to_sdk import AGUIToSDKTranslator, ClientToolPending
from .helpers import (
    coerce_to_str,
    new_message_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
)
from .sdk_to_agui import SDKToAGUITranslator
from .stream_types import (
    HOSTED_TOOL_CALL_TYPES,
    RawResponseEventType,
    SDKItemType,
    SDKStreamEventType,
)
from .types import TranslatedInput

__all__ = [
    # Engine translators
    "AGUIToSDKTranslator",
    "SDKToAGUITranslator",
    # Result types
    "TranslatedInput",
    # Wire discriminators
    "SDKStreamEventType",
    "RawResponseEventType",
    "SDKItemType",
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
