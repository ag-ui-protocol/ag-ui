import json
import re
from typing import List, Any, Dict, Union
from dataclasses import is_dataclass, asdict
from datetime import date, datetime

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
from .types import State, SchemaKeys, LangGraphReasoning

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

def langchain_messages_to_agui(messages: List[BaseMessage]) -> List[AGUIMessage]:
    agui_messages: List[AGUIMessage] = []
    for message in messages:
        if isinstance(message, HumanMessage):
            agui_messages.append(AGUIUserMessage(
                id=str(message.id),
                role="user",
                content=stringify_if_needed(resolve_message_content(message.content)),
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

def resolve_reasoning_content(chunk: Any) -> LangGraphReasoning | None:
    content = chunk.content
    if not content:
        return None

    # Anthropic reasoning response
    if isinstance(content, list) and content and content[0]:
        if not content[0].get("thinking"):
            return None
        return LangGraphReasoning(
            text=content[0]["thinking"],
            type="text",
            index=content[0].get("index", 0)
        )

    # OpenAI reasoning response
    if hasattr(chunk, "additional_kwargs"):
        reasoning = chunk.additional_kwargs.get("reasoning", {})
        summary = reasoning.get("summary", [])
        if summary:
            data = summary[0]
            if not data or not data.get("text"):
                return None
            return LangGraphReasoning(
                type="text",
                text=data["text"],
                index=data.get("index", 0)
            )

    return None

def resolve_message_content(content: Any) -> str | None:
    if not content:
        return None

    if isinstance(content, str):
        return content

    if isinstance(content, list) and content:
        content_text = next((c.get("text") for c in content if isinstance(c, dict) and c.get("type") == "text"), None)
        return content_text

    return None

def camel_to_snake(name):
    return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

def json_safe_stringify(o):
    if is_dataclass(o):          # dataclasses like Flight(...)
        return asdict(o)
    if hasattr(o, "model_dump"): # pydantic v2
        return o.model_dump()
    if hasattr(o, "dict"):       # pydantic v1
        return o.dict()
    if hasattr(o, "__dict__"):   # plain objects
        return vars(o)
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)                # last resort

def make_json_safe(value: Any) -> Any:
    """
    Recursively convert a value into a JSON-serializable structure.

    - Handles Pydantic models via `model_dump`.
    - Handles LangChain messages via `to_dict`.
    - Recursively walks dicts, lists, and tuples.
    - For arbitrary objects, falls back to `__dict__` if available, else `repr()`.
    """
    # Pydantic models
    if hasattr(value, "model_dump"):
        try:
            return make_json_safe(value.model_dump(by_alias=True, exclude_none=True))
        except Exception:
            pass

    # LangChain-style objects
    if hasattr(value, "to_dict"):
        try:
            return make_json_safe(value.to_dict())
        except Exception:
            pass

    # Dict
    if isinstance(value, dict):
        return {key: make_json_safe(sub_value) for key, sub_value in value.items()}

    # List / tuple
    if isinstance(value, (list, tuple)):
        return [make_json_safe(sub_value) for sub_value in value]

    # Already JSON safe
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value

    # Arbitrary object: try __dict__ first, fallback to repr
    if hasattr(value, "__dict__"):
        return {
            "__type__": type(value).__name__,
            **make_json_safe(value.__dict__),
        }

    return repr(value)