"""
Type definitions for AG-UI Claude SDK integration.

These TypedDicts provide structured typing for internal adapter state.
"""

from typing import TypedDict, Any, Literal


__all__ = ["MessageHistory", "ActivityState", "ActivityStatus"]


# Activity status literals
ActivityStatus = Literal["pending", "running", "completed", "error"]


class MessageHistory(TypedDict):
    """Message in conversation history."""
    id: str
    role: Literal["user", "assistant", "system", "tool"]
    content: str
    

class ActivityState(TypedDict, total=False):
    """
    State of an activity (e.g., tool execution).
    
    Used for ActivitySnapshotEvent and ActivityDeltaEvent payloads.
    """
    tool: str
    status: ActivityStatus
    start_time: str
    end_time: str
    result: Any
    error: str

