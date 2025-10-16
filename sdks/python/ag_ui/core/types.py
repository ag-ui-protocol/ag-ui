"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

import base64
from typing import Annotated, Any, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator
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


class TextInputContent(ConfiguredBaseModel):
    """Text segment included in a multimodal message."""

    type: Literal["text"] = "text"  # pyright: ignore[reportIncompatibleVariableOverride]
    text: str

    @model_validator(mode="after")
    def validate_text(cls, values: "TextInputContent") -> "TextInputContent":
        if values.text.strip() == "":
            raise ValueError("Text content must not be empty.")
        return values


class BinaryInputContent(ConfiguredBaseModel):
    """Binary payload metadata for multimodal messages."""

    type: Literal["binary"] = "binary"  # pyright: ignore[reportIncompatibleVariableOverride]
    mime_type: str
    id: Optional[str] = None
    url: Optional[str] = None
    data: Optional[str] = None
    filename: Optional[str] = None

    @model_validator(mode="after")
    def validate_reference(cls, values: "BinaryInputContent") -> "BinaryInputContent":
        if not (values.id or values.url or values.data):
            raise ValueError("Binary content requires data, url, or id.")
        return values


InputContent = Annotated[
    Union[TextInputContent, BinaryInputContent],
    Field(discriminator="type"),
]


class BaseMessage(ConfiguredBaseModel):
    """
    A base message, modelled after OpenAI messages.
    """
    id: str
    role: str
    content: Optional[Union[str, List[InputContent]]] = None
    name: Optional[str] = None


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


class UserMessage(BaseMessage):
    """
    A user message.
    """
    role: Literal["user"] = "user" # pyright: ignore[reportIncompatibleVariableOverride]
    content: Optional[Union[str, List[InputContent]]] = None

    @model_validator(mode="after")
    def ensure_body(cls, values: "UserMessage") -> "UserMessage":
        content = values.content

        if content is None:
            raise ValueError("User messages must include content.")

        if isinstance(content, str):
            if content.strip() == "":
                raise ValueError("User messages must include non-empty text or binary content.")
            return values

        if len(content) == 0:
            raise ValueError("User messages must include non-empty text or binary content.")

        return values


class ToolMessage(ConfiguredBaseModel):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str
    error: Optional[str] = None


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


def create_text_input_content(text: str) -> TextInputContent:
    """Construct a text input content item."""

    return TextInputContent(text=text)


def create_binary_input_content(
    *,
    mime_type: str,
    id: Optional[str] = None,
    url: Optional[str] = None,
    data: Optional[str] = None,
    filename: Optional[str] = None,
) -> BinaryInputContent:
    """Construct a binary input content item."""

    return BinaryInputContent(
        mime_type=mime_type,
        id=id,
        url=url,
        data=data,
        filename=filename,
    )


def normalize_input_content(content: Union[str, List[InputContent]]) -> List[InputContent]:
    """Normalize user message content to a list of input content items."""

    if isinstance(content, list):
        return content
    return [create_text_input_content(content)]


def encode_binary_data(data: bytes) -> str:
    """Encode bytes as a base64 string for binary content."""

    return base64.b64encode(data).decode("ascii")


def decode_binary_data(data: str) -> bytes:
    """Decode a base64 string back to bytes."""

    return base64.b64decode(data.encode("ascii"))
