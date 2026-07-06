"""
Engine layer — the per-direction translation logic under the facades.

Advanced API: subclass an engine to customize one mapping (design rule 4)
and inject it into a facade via ``inbound_cls`` / ``outbound_cls``. For
normal use import the facades from the package root instead
(:class:`~ag_ui_openai_agents.AGUITranslator`,
:class:`~ag_ui_openai_agents.AGUINonStreamingTranslator`).

::

    from ag_ui_openai_agents.engine import (
        AGUIToSDKTranslator,         # inbound:  AG-UI primitives → SDK shapes
        SDKToAGUITranslator,         # outbound: SDK formats → AG-UI primitives
        TranslatedInput,             # Pydantic bundle returned by translate()/to_sdk()
        ClientToolPending,           # sentinel raised by client-tool proxies
    )
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
