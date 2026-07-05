"""
Bi-directional translation between AG-UI and the OpenAI Agents SDK.

Two independent classes — one per direction — plus shared helpers and a
typed result container. Import what you need::

    from ag_ui_openai_agents.translator import (
        AGUIToSDKTranslator,     # inbound:  AG-UI primitives  → SDK shapes
        SDKToAGUITranslator,     # outbound: SDK formats → AG-UI primitives
        TranslatedInput,         # Pydantic bundle returned by translate()
        ClientToolPending,       # sentinel raised by client-tool proxies
        StateDiffer,             # JSON Patch helper for STATE_DELTA events
    )
"""

from __future__ import annotations

from .agui_to_sdk import AGUIToSDKTranslator, ClientToolPending
from .helpers import (
    StateDiffer,
    coerce_to_str,
    new_message_id,
    new_tool_call_id,
    new_tool_result_id,
    read_attr,
    snapshot_state,
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
    # Translators
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
    "StateDiffer",
    "snapshot_state",
    "new_message_id",
    "new_tool_call_id",
    "new_tool_result_id",
    "read_attr",
    "coerce_to_str",
]
