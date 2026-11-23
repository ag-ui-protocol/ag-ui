"""AG-UI shared state that tools can read and update while the run streams.

AG-UI sends the client's state with every request (``RunAgentInput.state``).
A ``SharedState`` holds it for one run. Tools, and dynamic instructions,
reach it with ``shared_state()``. Every change is queued as a
``STATE_SNAPSHOT`` that ``AGUITranslator.to_agui(..., shared_state=...)``
streams as soon as the SDK reports its next event, so a tool's state change
reaches the client before the tool's result does.

The handle travels in a context variable, not in the SDK run context, so it
works whatever context type the application gives its agents. The variable
must be set when the SDK run starts: ``Runner.run_streamed`` starts its run
in a new task, which copies the context of the moment it was created.

Example:
    @function_tool
    def add_item(name: str) -> str:
        items = shared_state().value.get("items", [])
        shared_state().update(items=[*items, name])
        return f"Added {name}."

    state = SharedState(run_input.state)
    with use_shared_state(state):
        result = Runner.run_streamed(agent, input=translated.messages)
    async for event in translator.to_agui(result, run_input, shared_state=state):
        ...
"""

from __future__ import annotations

import copy
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from ag_ui.core import EventType, StateSnapshotEvent

_current: ContextVar[SharedState | None] = ContextVar("ag_ui_shared_state", default=None)


class SharedState:
    """One run's AG-UI state, readable and writable from tools."""

    def __init__(self, initial: Any = None) -> None:
        """Start from the client's state.

        Args:
            initial: ``RunAgentInput.state``. Copied, so changes never reach
                the request object. ``None`` starts from an empty dict.
        """
        self._value: Any = copy.deepcopy(initial) if initial is not None else {}
        self._pending: list[StateSnapshotEvent] = []

    @property
    def value(self) -> Any:
        """The current state. Treat it as read-only; change it with set/update."""
        return self._value

    def set(self, value: Any) -> None:
        """Replace the state and queue a STATE_SNAPSHOT of it."""
        self._value = value
        self._pending.append(
            StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=copy.deepcopy(value))
        )

    def update(self, **changes: Any) -> None:
        """Merge top-level keys into a dict state and queue a STATE_SNAPSHOT.

        Raises:
            TypeError: The state is not a mapping.
        """
        if not isinstance(self._value, Mapping):
            raise TypeError(
                f"update() needs a mapping state, got {type(self._value).__name__}; use set()"
            )
        self.set({**self._value, **changes})

    def drain(self) -> list[StateSnapshotEvent]:
        """Take the snapshots queued since the last drain, oldest first."""
        pending, self._pending = self._pending, []
        return pending


def shared_state() -> SharedState:
    """The shared state of the run this code is part of.

    Raises:
        LookupError: Called outside a run that has shared state.
    """
    state = _current.get()
    if state is None:
        raise LookupError(
            "No AG-UI shared state here: start the SDK run inside use_shared_state(...)"
        )
    return state


@contextmanager
def use_shared_state(state: SharedState) -> Iterator[SharedState]:
    """Make ``state`` what ``shared_state()`` returns inside this block.

    Start the SDK run (``Runner.run_streamed``) inside it; the run keeps the
    state after the block ends.
    """
    token = _current.set(state)
    try:
        yield state
    finally:
        _current.reset(token)


__all__ = ["SharedState", "shared_state", "use_shared_state"]
