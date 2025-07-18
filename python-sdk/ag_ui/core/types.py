"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

from typing import Annotated, Any, Iterable, List, Literal, Optional, Required, TypeAlias, Union

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class ConfiguredBaseModel(BaseModel):
    """
    A configurable base model.
    """
    model_config = ConfigDict(
        extra="forbid",
        alias_generator=to_camel,
        populate_by_name=True,
    )


class FunctionCall(ConfiguredBaseModel):
    """
    Name and arguments of a function call.
    """
    name: str
    arguments: str


class ToolCall(ConfiguredBaseModel):
    """
    A tool call, modelled after OpenAI tool calls.
    """
    id: str
    type: Literal["function"] = "function"  # pyright: ignore[reportIncompatibleVariableOverride]
    function: FunctionCall


class BaseMessage(ConfiguredBaseModel):
    """
    A base message, modelled after OpenAI messages.
    """
    id: str
    role: str
    content: Optional[str] = None
    name: Optional[str] = None


class FileWithBytes(ConfiguredBaseModel):
    """
    Define the variant where 'bytes' is present and 'uri' is absent
    """

    bytes: str
    """
    base64 encoded content of the file
    """
    mimeType: str | None = None
    """
    Optional mimeType for the file
    """
    name: str | None = None
    """
    Optional name for the file
    """

class FileWithUri(ConfiguredBaseModel):
    """
    Define the variant where 'uri' is present and 'bytes' is absent
    """

    mimeType: str | None = None
    """
    Optional mimeType for the file
    """
    name: str | None = None
    """
    Optional name for the file
    """
    uri: str
    """
    URL for the File content
    """

class FilePart(ConfiguredBaseModel):
    """
    Represents a File segment within parts.
    """

    file: FileWithBytes | FileWithUri
    """
    File content either as url or bytes
    """
    type: Literal["file"] = "file"
    """
    Part type - file for FileParts
    """
    metadata: dict[str, Any] | None = None
    """
    Optional metadata associated with the part.
    """

class ImagePart(FilePart):
    type: Literal["image"] = "image"

class AudioPart(FilePart):
    type: Literal["audio"] = "audio"

class TextPart(ConfiguredBaseModel):
    type: Literal["text"] = "text"
    text: str

MultipleModalPart: TypeAlias = Union[
    TextPart,
    AudioPart,
    ImagePart,
    FilePart,
]

class DeveloperMessage(BaseMessage):
    """
    A developer message.
    """
    role: Literal["developer"] = "developer"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str


class SystemMessage(BaseMessage):
    """
    A system message.
    """
    role: Literal["system"] = "system"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: str


class AssistantMessage(BaseMessage):
    """
    An assistant message.
    """
    role: Literal["assistant"] = "assistant"  # pyright: ignore[reportIncompatibleVariableOverride]
    tool_calls: Optional[List[ToolCall]] = None
    content: Optional[str | Iterable[MultipleModalPart]] = None


class UserMessage(BaseMessage):
    """
    A user message.
    """
    role: Literal["user"] = "user" # pyright: ignore[reportIncompatibleVariableOverride]
    content: Required[str | Iterable[MultipleModalPart]] = None


class ToolMessage(ConfiguredBaseModel):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str


Message = Annotated[
    Union[DeveloperMessage, SystemMessage, AssistantMessage, UserMessage, ToolMessage],
    Field(discriminator="role")
]

Role = Literal["developer", "system", "assistant", "user", "tool"]


class Context(ConfiguredBaseModel):
    """
    Additional context for the agent.
    """
    description: str
    value: str


class Tool(ConfiguredBaseModel):
    """
    A tool definition.
    """
    name: str
    description: str
    parameters: Any  # JSON Schema for the tool parameters


class RunAgentInput(ConfiguredBaseModel):
    """
    Input for running an agent.
    """
    thread_id: str
    run_id: str
    state: Any
    messages: List[Message]
    tools: List[Tool]
    context: List[Context]
    forwarded_props: Any


# State can be any type
State = Any
