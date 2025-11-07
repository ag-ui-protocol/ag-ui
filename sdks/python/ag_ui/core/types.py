"""
This module contains the types for the Agent User Interaction Protocol Python SDK.
"""

from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel


class ConfiguredBaseModel(BaseModel):
    """
    A configurable base model.
    """
    model_config = ConfigDict(
        extra="allow",
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


class TextInputContent(ConfiguredBaseModel):
    """A text fragment in a multimodal user message."""

    type: Literal["text"] = "text"
    text: str


class BinaryInputContent(ConfiguredBaseModel):
    """A binary payload reference in a multimodal user message."""

    type: Literal["binary"] = "binary"  # pyright: ignore[reportIncompatibleVariableOverride]
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


InputContent = Annotated[
    Union[TextInputContent, BinaryInputContent],
    Field(discriminator="type"),
]


class UserMessage(BaseMessage):
    """
    A user message supporting text or multimodal content.
    """

    role: Literal["user"] = "user"  # pyright: ignore[reportIncompatibleVariableOverride]
    content: Union[str, List[InputContent]]


class ToolMessage(ConfiguredBaseModel):
    """
    A tool result message.
    """
    id: str
    role: Literal["tool"] = "tool"
    content: str
    tool_call_id: str
    error: Optional[str] = None


class ActivityMessage(ConfiguredBaseModel):
    """
    An activity progress message emitted between chat messages.
    """

    id: str
    role: Literal["activity"] = "activity"  # pyright: ignore[reportIncompatibleVariableOverride]
    activity_type: str
    content: Dict[str, Any]


Message = Annotated[
    Union[
        DeveloperMessage,
        SystemMessage,
        AssistantMessage,
        UserMessage,
        ToolMessage,
        ActivityMessage,
    ],
    Field(discriminator="role")
]

Role = Literal["developer", "system", "assistant", "user", "tool", "activity"]


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
    parent_run_id: Optional[str] = None
    state: Any
    messages: List[Message]
    tools: List[Tool]
    context: List[Context]
    forwarded_props: Any


# State can be any type
State = Any
