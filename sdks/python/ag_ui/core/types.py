"""
This module contains the types for the Agent User Interaction Protocol.

Since PNI-213 it is a compatibility surface: every protocol shape is
re-exported from the generated models (``ag_ui._generated.models``, emitted
from ``spec/draft/schema.json`` — regenerate with
``pnpm --filter @ag-ui/spec generate``). Only the package's own non-protocol
pieces (the reserved metadata key, historic aliases) are declared here.

The legacy ``BinaryInputContent`` part left the protocol in 1.0 (see
DEPRECATIONS.md): producers send the media parts (image, audio, video,
document) with a ``source``. Two TypeScript shims cover it, and both move in
the SAME direction — legacy to modern. The always-on inbound compatibility
boundary (``CompatibilityBoundary``) upgrades a legacy part arriving inside a
message, and the version-gated ``BackwardCompatibility_0_0_47`` middleware
upgrades one on the way out, rewriting ``RunAgentInput.messages`` through
``convertBinaryToNewFormat`` before the request is sent. Nothing converts a
modern media part back to ``{"type": "binary"}``. The version gate is about
the CALLER rather than the payload: an application still assembling messages
the pre-0.0.48 way is the only place a legacy part can still enter, so the
upgrade is installed for exactly those peers and skipped for everyone else.
"""

from typing import Literal

from ag_ui._generated.models import (
    GeneratedBaseModel,
    Attributable,
    Metadata,
    SubagentRunId,
    FunctionCall,
    ToolCall,
    BaseMessage,
    DeveloperMessage,
    SystemMessage,
    AssistantMessage,
    UserMessage,
    ToolMessage,
    ActivityMessage,
    ReasoningMessage,
    Message,
    Role,
    Context,
    Tool,
    Interrupt,
    ResumeEntry,
    RunAgentInput,
    State,
    TextPart,
    DataSource,
    UrlSource,
    PartSource,
    ImagePart,
    AudioPart,
    VideoPart,
    DocumentPart,
    ContentPart,
)

AGUI_METADATA_KEY = "ag-ui"
"""
The key reserved for AG-UI's own use inside a metadata object. Every other key
is user space.

Reservation is by convention: nothing rejects a write to this key at runtime,
because metadata is open by key and validating its shape would contradict that.
"""

ConfiguredBaseModel = GeneratedBaseModel
"""
Historic name for the configured pydantic base every model shares. The
configuration itself now lives on the generated base (camelCase aliases,
populate by name, unknown fields kept).
"""

ResumeStatus = Literal["resolved", "cancelled"]
"""Whether the interrupt was answered or abandoned (ResumeEntry.status)."""

# The names the content parts carried before 1.0 renamed them (InputContent
# -> ContentPart, TextInputContent -> TextPart, and so on): the same parts now
# sit on tool messages as well as user messages, so they are named by what they
# are rather than by direction. The wire is unchanged — every ``type`` value is
# the same — and so is every class behind these names; only the spelling moved.
# Kept for one release, see the repo-root DEPRECATIONS.md.
InputContent = ContentPart
TextInputContent = TextPart
ImageInputContent = ImagePart
AudioInputContent = AudioPart
VideoInputContent = VideoPart
DocumentInputContent = DocumentPart
InputContentSource = PartSource
InputContentDataSource = DataSource
InputContentUrlSource = UrlSource

# Historic aliases for the media parts: this package has always also exported
# them as ...InputPart.
ImageInputPart = ImagePart
AudioInputPart = AudioPart
VideoInputPart = VideoPart
DocumentInputPart = DocumentPart

InputContentPart = ContentPart
"""Historic alias: a content part of a user message."""

__all__ = [
    "AGUI_METADATA_KEY",
    "Metadata",
    "SubagentRunId",
    "ConfiguredBaseModel",
    "GeneratedBaseModel",
    "Attributable",
    "FunctionCall",
    "ToolCall",
    "BaseMessage",
    "DeveloperMessage",
    "SystemMessage",
    "AssistantMessage",
    "UserMessage",
    "ToolMessage",
    "ActivityMessage",
    "ReasoningMessage",
    "Message",
    "Role",
    "Context",
    "Tool",
    "Interrupt",
    "ResumeEntry",
    "ResumeStatus",
    "RunAgentInput",
    "State",
    "ContentPart",
    "TextPart",
    "ImagePart",
    "AudioPart",
    "VideoPart",
    "DocumentPart",
    "PartSource",
    "DataSource",
    "UrlSource",
    "InputContent",
    "TextInputContent",
    "InputContentDataSource",
    "InputContentUrlSource",
    "InputContentSource",
    "ImageInputContent",
    "AudioInputContent",
    "VideoInputContent",
    "DocumentInputContent",
    "ImageInputPart",
    "AudioInputPart",
    "VideoInputPart",
    "DocumentInputPart",
    "InputContentPart",
]
