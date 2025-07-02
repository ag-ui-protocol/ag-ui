import json
from typing import List, Any, Dict, Union

from langchain_core.messages import BaseMessage, HumanMessage, AIMessage, SystemMessage, ToolMessage
from ag_ui.core import (
    Message as AGUIMessage,
    UserMessage as AGUIUserMessage,
    AssistantMessage as AGUIAssistantMessage,
    SystemMessage as AGUISystemMessage,
    ToolMessage as AGUIToolMessage,
    ToolCall as AGUIToolCall,
    FunctionCall as AGUIFunctionCall,
)
from .types import State, SchemaKeys

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
    if isinstance(item, str):
        return item
    return json.dumps(item)

def langchain_messages_to_agui(messages: List[BaseMessage]) -> List[AGUIMessage]:
    agui_messages: List[AGUIMessage] = []
    for message in messages:
        if isinstance(message, HumanMessage):
            agui_messages.append(AGUIUserMessage(
                id=str(message.id),
                role="user",
                content=stringify_if_needed(message.content),
                name=message.name,
            ))
        elif isinstance(message, AIMessage):
            tool_calls = None
            if message.tool_calls:
                tool_calls = [
                    AGUIToolCall(
                        id=str(tc["id"]),
                        type="function",
                        function=AGUIFunctionCall(
                            name=tc["name"],
                            arguments=json.dumps(tc.get("args", {})),
                        ),
                    )
                    for tc in message.tool_calls
                ]
            agui_messages.append(AGUIAssistantMessage(
                id=str(message.id),
                role="assistant",
                content=stringify_if_needed(message.content),
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif isinstance(message, SystemMessage):
            agui_messages.append(AGUISystemMessage(
                id=str(message.id),
                role="system",
                content=stringify_if_needed(message.content),
                name=message.name,
            ))
        elif isinstance(message, ToolMessage):
            agui_messages.append(AGUIToolMessage(
                id=str(message.id),
                role="tool",
                content=stringify_if_needed(message.content),
                tool_call_id=message.tool_call_id,
            ))
        else:
            raise TypeError(f"Unsupported message type: {type(message)}")
    return agui_messages

def agui_messages_to_langchain(messages: List[AGUIMessage]) -> List[BaseMessage]:
    langchain_messages = []
    for message in messages:
        role = message.role
        if role == "user":
            langchain_messages.append(HumanMessage(
                id=message.id,
                content=message.content,
                name=message.name,
            ))
        elif role == "assistant":
            tool_calls = []
            if hasattr(message, "tool_calls") and message.tool_calls:
                for tc in message.tool_calls:
                    tool_calls.append({
                        "id": tc.id,
                        "name": tc.function.name,
                        "args": json.loads(tc.function.arguments) if hasattr(tc, "function") and tc.function.arguments else {},
                        "type": "tool_call",
                    })
            langchain_messages.append(AIMessage(
                id=message.id,
                content=message.content or "",
                tool_calls=tool_calls,
                name=message.name,
            ))
        elif role == "system":
            langchain_messages.append(SystemMessage(
                id=message.id,
                content=message.content,
                name=message.name,
            ))
        elif role == "tool":
            langchain_messages.append(ToolMessage(
                id=message.id,
                content=message.content,
                tool_call_id=message.tool_call_id,
            ))
        else:
            raise ValueError(f"Unsupported message role: {role}")
    return langchain_messages