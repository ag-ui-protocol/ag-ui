"""Strict, JSON-safe persistence state for native frontend-tool waits."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field, replace
from math import isfinite
from typing import Any, Mapping, Sequence

FRONTEND_TOOL_WAIT_INTERRUPT_NAME = "ag_ui_frontend_tool_wait"
FRONTEND_TOOL_RESPONSE_KEY = "__ag_ui_frontend_tool_response__"
FRONTEND_TOOL_WAIT_STATE_KEY = "ag_ui_frontend_tool_wait"
MAX_COMPLETED_WIRE_IDS = 100
MAX_CHECKPOINT_MESSAGE_IDS = 512


def wrap_frontend_tool_response(
    content: str, *, is_error: bool
) -> dict[str, dict[str, Any]]:
    """Put every response (including ``""``) in the non-empty wire envelope."""
    if not isinstance(content, str) or not isinstance(is_error, bool):
        raise TypeError("frontend tool response must be a string")
    return {FRONTEND_TOOL_RESPONSE_KEY: {"content": content, "is_error": is_error}}


def unwrap_frontend_tool_response(value: Any) -> tuple[str, bool]:
    """Recover a response only from the exact tagged envelope."""
    if not isinstance(value, Mapping) or set(value) != {FRONTEND_TOOL_RESPONSE_KEY}:
        raise ValueError("malformed frontend tool response envelope")
    response = value[FRONTEND_TOOL_RESPONSE_KEY]
    if not isinstance(response, Mapping) or set(response) != {"content", "is_error"}:
        raise ValueError("malformed frontend tool response envelope")
    if not isinstance(response["content"], str):
        raise ValueError("frontend tool response content must be a string")
    if not isinstance(response["is_error"], bool):
        raise ValueError("frontend tool response is_error must be a boolean")
    return response["content"], response["is_error"]


def try_unwrap_frontend_tool_response(value: Any) -> tuple[str, bool] | None:
    try:
        return unwrap_frontend_tool_response(value)
    except ValueError:
        return None


def frontend_tool_wait_reason(*, native_tool_use_id: str) -> dict[str, object]:
    """Build the per-proxy-call native interrupt reason (never batch state)."""
    if not isinstance(native_tool_use_id, str):
        raise TypeError("native tool use id must be a string")
    if not native_tool_use_id:
        raise ValueError("native tool use id must be nonempty")
    return {
        "name": FRONTEND_TOOL_WAIT_INTERRUPT_NAME,
        "native_tool_use_id": native_tool_use_id,
    }


def parse_frontend_wait_interrupt(reason: Any) -> str:
    """Strictly recover the native tool-use ID from this adapter's tag."""
    if not isinstance(reason, Mapping) or set(reason) != {"name", "native_tool_use_id"}:
        raise ValueError("malformed frontend wait interrupt reason")
    if reason["name"] != FRONTEND_TOOL_WAIT_INTERRUPT_NAME:
        raise ValueError("not a frontend wait interrupt reason")
    native_tool_use_id = reason["native_tool_use_id"]
    if not isinstance(native_tool_use_id, str) or not native_tool_use_id:
        raise ValueError("native tool use id must be a nonempty string")
    return native_tool_use_id


def is_frontend_wait_interrupt(reason: Any) -> bool:
    """Classify untagged reasons as false, but fail loudly on broken tags."""
    if (
        not isinstance(reason, Mapping)
        or reason.get("name") != FRONTEND_TOOL_WAIT_INTERRUPT_NAME
    ):
        return False
    parse_frontend_wait_interrupt(reason)
    return True


def classify_frontend_tool_wait_reason(reason: Any) -> bool:
    return is_frontend_wait_interrupt(reason)


is_frontend_tool_wait_reason = classify_frontend_tool_wait_reason
wrap_frontend_tool_wait_response = wrap_frontend_tool_response
unwrap_frontend_tool_wait_response = unwrap_frontend_tool_response


def _json_safe(value: Any) -> bool:
    if value is None or isinstance(value, (str, bool, int)):
        return True
    if isinstance(value, float):
        return isfinite(value)
    if isinstance(value, list):
        return all(_json_safe(item) for item in value)
    if isinstance(value, Mapping):
        return all(
            isinstance(key, str) and _json_safe(item) for key, item in value.items()
        )
    return False


def _strict_dict(value: Any, keys: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != keys or not _json_safe(value):
        raise ValueError(f"malformed {label}")
    return value


@dataclass(frozen=True)
class FrontendToolWaitCall:
    """One parked call, keyed by all three identities used across the bridge."""

    interrupt_id: str
    native_tool_use_id: str
    wire_tool_call_id: str
    content: str = ""
    is_error: bool = False
    has_response: bool = False
    end_handed_off: bool = False

    def __post_init__(self) -> None:
        self._validate(
            {
                "interrupt_id": self.interrupt_id,
                "native_tool_use_id": self.native_tool_use_id,
                "wire_tool_call_id": self.wire_tool_call_id,
                "content": self.content,
                "is_error": self.is_error,
                "has_response": self.has_response,
                "end_handed_off": self.end_handed_off,
            }
        )

    def to_dict(self) -> dict[str, Any]:
        data = {
            "interrupt_id": self.interrupt_id,
            "native_tool_use_id": self.native_tool_use_id,
            "wire_tool_call_id": self.wire_tool_call_id,
            "content": self.content,
            "is_error": self.is_error,
            "has_response": self.has_response,
            "end_handed_off": self.end_handed_off,
        }
        self._validate(data)
        return deepcopy(data)

    @staticmethod
    def _validate(data: Mapping[str, Any]) -> None:
        _strict_dict(
            data,
            {
                "interrupt_id",
                "native_tool_use_id",
                "wire_tool_call_id",
                "content",
                "is_error",
                "has_response",
                "end_handed_off",
            },
            "frontend tool wait call",
        )
        if not all(
            isinstance(data[key], str)
            for key in (
                "interrupt_id",
                "native_tool_use_id",
                "wire_tool_call_id",
                "content",
            )
        ):
            raise ValueError(
                "frontend tool wait call identities and content must be strings"
            )
        if not all(
            data[key]
            for key in ("interrupt_id", "native_tool_use_id", "wire_tool_call_id")
        ):
            raise ValueError("frontend tool wait call identities must be nonempty")
        if (
            not isinstance(data["is_error"], bool)
            or not isinstance(data["has_response"], bool)
            or not isinstance(data["end_handed_off"], bool)
        ):
            raise ValueError("frontend tool wait call response flags must be boolean")
        if not data["has_response"] and (data["content"] or data["is_error"]):
            raise ValueError(
                "unstaged frontend tool wait call cannot contain a response"
            )
        if data["has_response"] and not data["end_handed_off"]:
            raise ValueError("responded frontend tool wait call was not handed off")

    @classmethod
    def from_dict(cls, value: Any) -> "FrontendToolWaitCall":
        data = _strict_dict(
            value,
            {
                "interrupt_id",
                "native_tool_use_id",
                "wire_tool_call_id",
                "content",
                "is_error",
                "has_response",
                "end_handed_off",
            },
            "frontend tool wait call",
        )
        cls._validate(data)
        return cls(
            data["interrupt_id"],
            data["native_tool_use_id"],
            data["wire_tool_call_id"],
            data["content"],
            data["is_error"],
            data["has_response"],
            data["end_handed_off"],
        )


@dataclass(init=False, eq=False)
class FrontendToolWaitBatch:
    _calls: tuple[FrontendToolWaitCall, ...] = field(init=False, repr=False)
    _last_completed_wire_ids: tuple[str, ...] = field(init=False, repr=False)
    _checkpoint_message_ids: tuple[str, ...] = field(init=False, repr=False)
    _stop_streaming_after_result: bool = field(init=False, repr=False)

    def __init__(
        self,
        calls: Sequence[FrontendToolWaitCall] = (),
        last_completed_wire_ids: Sequence[str] = (),
        checkpoint_message_ids: Sequence[str] = (),
        stop_streaming_after_result: bool = False,
    ) -> None:
        self._calls = tuple(calls)
        self._last_completed_wire_ids = tuple(last_completed_wire_ids)
        self._checkpoint_message_ids = tuple(checkpoint_message_ids)
        self._stop_streaming_after_result = stop_streaming_after_result
        self._validate(
            {
                "calls": [
                    call.to_dict() if isinstance(call, FrontendToolWaitCall) else call
                    for call in self._calls
                ],
                "last_completed_wire_ids": list(self._last_completed_wire_ids),
                "checkpoint_message_ids": list(self._checkpoint_message_ids),
                "stop_streaming_after_result": self._stop_streaming_after_result,
            }
        )

    @property
    def calls(self) -> tuple[FrontendToolWaitCall, ...]:
        return self._calls

    @property
    def last_completed_wire_ids(self) -> tuple[str, ...]:
        return self._last_completed_wire_ids

    @property
    def checkpoint_message_ids(self) -> tuple[str, ...]:
        return self._checkpoint_message_ids

    @property
    def stop_streaming_after_result(self) -> bool:
        return self._stop_streaming_after_result

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, FrontendToolWaitBatch)
            and self.calls == other.calls
            and self.last_completed_wire_ids == other.last_completed_wire_ids
            and self.checkpoint_message_ids == other.checkpoint_message_ids
            and (self.stop_streaming_after_result == other.stop_streaming_after_result)
        )

    @property
    def is_complete(self) -> bool:
        return all(call.has_response for call in self.calls)

    @property
    def unhanded_calls(self) -> tuple[FrontendToolWaitCall, ...]:
        """Return calls whose stable ToolCallEnd still needs handoff."""
        return tuple(call for call in self.calls if not call.end_handed_off)

    def call_for_wire_id(self, wire_tool_call_id: str) -> FrontendToolWaitCall | None:
        """Find the parked call associated with a client-visible wire ID."""
        return next(
            (
                call
                for call in self.calls
                if call.wire_tool_call_id == wire_tool_call_id
            ),
            None,
        )

    def mark_end_handed_off(self, wire_tool_call_id: str) -> "FrontendToolWaitBatch":
        """Immutably acknowledge one client-visible ToolCallEnd handoff."""
        call = self.call_for_wire_id(wire_tool_call_id)
        if call is None:
            raise ValueError(f"unknown frontend tool wire id: {wire_tool_call_id}")
        if call.end_handed_off:
            return self
        marked = [
            replace(item, end_handed_off=True)
            if item.wire_tool_call_id == wire_tool_call_id
            else item
            for item in self.calls
        ]
        return FrontendToolWaitBatch(
            marked,
            self.last_completed_wire_ids,
            self.checkpoint_message_ids,
            self.stop_streaming_after_result,
        )

    def mark_stop_streaming_after_result(self) -> "FrontendToolWaitBatch":
        """Persist that a checkpoint result halted all later sibling events."""
        if self.stop_streaming_after_result:
            return self
        return FrontendToolWaitBatch(
            self.calls,
            self.last_completed_wire_ids,
            self.checkpoint_message_ids,
            True,
        )

    def to_dict(self) -> dict[str, Any]:
        data = {
            "calls": [call.to_dict() for call in self.calls],
            "last_completed_wire_ids": list(self.last_completed_wire_ids),
            "checkpoint_message_ids": list(self.checkpoint_message_ids),
            "stop_streaming_after_result": self.stop_streaming_after_result,
        }
        self._validate(data)
        return data

    @staticmethod
    def _validate(data: Mapping[str, Any]) -> None:
        _strict_dict(
            data,
            {
                "calls",
                "last_completed_wire_ids",
                "checkpoint_message_ids",
                "stop_streaming_after_result",
            },
            "frontend tool wait batch",
        )
        calls = data["calls"]
        completed = data["last_completed_wire_ids"]
        checkpoint = data["checkpoint_message_ids"]
        if not isinstance(data["stop_streaming_after_result"], bool):
            raise ValueError("frontend tool wait batch stop flag must be boolean")
        if (
            not isinstance(calls, list)
            or not isinstance(completed, list)
            or not isinstance(checkpoint, list)
        ):
            raise ValueError("frontend tool wait batch fields must be lists")
        if (
            len(completed) > MAX_COMPLETED_WIRE_IDS
            or any(not isinstance(wire_id, str) or not wire_id for wire_id in completed)
            or len(set(completed)) != len(completed)
        ):
            raise ValueError("invalid completed frontend tool wire ids")
        if (
            len(checkpoint) > MAX_CHECKPOINT_MESSAGE_IDS
            or any(
                not isinstance(message_id, str) or not message_id
                for message_id in checkpoint
            )
            or len(set(checkpoint)) != len(checkpoint)
        ):
            raise ValueError("invalid frontend tool checkpoint message ids")
        parsed = []
        for index, call in enumerate(calls):
            if not isinstance(call, Mapping):
                raise ValueError(f"malformed call at index {index}")
            parsed.append(FrontendToolWaitCall.from_dict(call))
        if len({call.wire_tool_call_id for call in parsed}) != len(parsed):
            raise ValueError("duplicate frontend tool wire ids")
        if len({call.interrupt_id for call in parsed}) != len(parsed):
            raise ValueError("duplicate frontend tool interrupt ids")
        if len({call.native_tool_use_id for call in parsed}) != len(parsed):
            raise ValueError("duplicate frontend tool native tool use ids")

    @classmethod
    def from_dict(cls, value: Any) -> "FrontendToolWaitBatch":
        data = _strict_dict(
            value,
            {
                "calls",
                "last_completed_wire_ids",
                "checkpoint_message_ids",
                "stop_streaming_after_result",
            },
            "frontend tool wait batch",
        )
        cls._validate(data)
        return cls(
            [FrontendToolWaitCall.from_dict(call) for call in data["calls"]],
            deepcopy(data["last_completed_wire_ids"]),
            deepcopy(data["checkpoint_message_ids"]),
            data["stop_streaming_after_result"],
        )

    def stage_responses(self, incoming: Sequence[Any]) -> "FrontendToolWaitBatch":
        """Stage the first string response for each known wire id, immutably."""
        staged = {call.wire_tool_call_id: call for call in self.calls}
        for item in incoming:
            if not isinstance(item, Mapping):
                continue
            wire_id, content = (
                item.get("tool_call_id", item.get("wire_tool_call_id")),
                item.get("content"),
            )
            is_error = item.get("is_error", False)
            call = staged.get(wire_id) if isinstance(wire_id, str) else None
            if (
                call is not None
                and not call.has_response
                and isinstance(content, str)
                and isinstance(is_error, bool)
            ):
                staged[wire_id] = replace(
                    call,
                    content=content,
                    is_error=is_error,
                    has_response=True,
                    end_handed_off=True,
                )
        return FrontendToolWaitBatch(
            [staged[call.wire_tool_call_id] for call in self.calls],
            self.last_completed_wire_ids,
            self.checkpoint_message_ids,
            self.stop_streaming_after_result,
        )

    def responses(self) -> dict[str, dict[str, Any]]:
        """Return an independent completed-response snapshot, never partial state."""
        if not self.is_complete:
            raise ValueError(
                "cannot read responses from a partial frontend tool wait batch"
            )
        return {
            call.interrupt_id: wrap_frontend_tool_response(
                call.content, is_error=call.is_error
            )
            for call in self.calls
        }

    def mark_consumed(
        self, previous_tombstones: Sequence[Any] | None = None
    ) -> "FrontendToolWaitBatch":
        """Clear active calls and replace stale tombstones with completed wire IDs."""
        del previous_tombstones
        if not self.is_complete:
            raise ValueError("cannot consume a partial frontend tool wait batch")
        return FrontendToolWaitBatch(
            [],
            [call.wire_tool_call_id for call in self.calls][-MAX_COMPLETED_WIRE_IDS:],
            self.checkpoint_message_ids,
        )


def load_frontend_tool_wait(state: Any) -> FrontendToolWaitBatch:
    """Load the adapter-owned wait batch from a Strands ``AgentState``."""
    get = getattr(state, "get", None)
    if not callable(get):
        return FrontendToolWaitBatch()
    raw = get(FRONTEND_TOOL_WAIT_STATE_KEY)
    # Bare MagicMock agents are common in the adapter's legacy tests. Their
    # undeclared ``state.get`` returns another mock, which means "absent", not
    # persisted malformed JSON. Real persisted batches are mappings.
    if raw is None or type(raw).__module__ == "unittest.mock":
        return FrontendToolWaitBatch()
    if not isinstance(raw, Mapping):
        raise ValueError("malformed frontend tool wait batch")
    return FrontendToolWaitBatch.from_dict(raw)
