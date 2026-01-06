"""Type definitions for AWS Strands integration."""

from typing import Dict, Any, List, Optional, Union
from enum import Enum
from pydantic import BaseModel

class StrandsEventTypes(str, Enum):
    """Event types for Strands streaming."""
    MESSAGE_START = "message_start"
    MESSAGE_CONTENT = "message_content"
    MESSAGE_END = "message_end"
    TOOL_CALL_START = "tool_call_start"
    TOOL_CALL_END = "tool_call_end"
    ERROR = "error"

class StrandsMessage(BaseModel):
    """Strands message structure."""
    role: str
    content: str
    timestamp: Optional[str] = None

class StrandsToolCall(BaseModel):
    """Strands tool call structure."""
    id: str
    name: str
    args: Dict[str, Any]
    result: Optional[Any] = None

class StrandsState(BaseModel):
    """Strands agent state."""
    messages: List[StrandsMessage] = []
    tool_calls: List[StrandsToolCall] = []
    metadata: Dict[str, Any] = {}