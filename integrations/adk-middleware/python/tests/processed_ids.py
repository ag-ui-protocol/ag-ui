"""Helpers for checking which processed-ID bucket a run's marks landed in."""

import asyncio
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from ag_ui.core import RunErrorEvent

OTHER_USER = "other_user"


def processed_id_view(session_manager, app_name: str, thread_id: str, user_id: str) -> Dict[str, Set[str]]:
    """Summarize a thread's processed IDs as seen by one user.

    ``get_processed_message_ids(user_id=...)`` also returns IDs marked without a
    user, so on its own it cannot show that marks were scoped. The view adds the
    raw scoped and unscoped buckets and what another user of the thread sees.
    """
    buckets = session_manager._processed_message_ids
    return {
        "scoped": set(buckets.get((app_name, user_id, thread_id), set())),
        "unscoped": set(buckets.get((app_name, None, thread_id), set())),
        "visible": session_manager.get_processed_message_ids(app_name, thread_id, user_id=user_id),
        "other_user": session_manager.get_processed_message_ids(app_name, thread_id, user_id=OTHER_USER),
    }


def scoped_only(expected: Set[str]) -> Dict[str, Set[str]]:
    """The view when exactly ``expected`` is marked, all in the user's own bucket."""
    return {"scoped": expected, "unscoped": set(), "visible": expected, "other_user": set()}


class RunnerEntryRecorder:
    """Wraps a mock runner and records a snapshot when run_async is called."""

    def __init__(self, runner: Any, snapshot: Callable[[], Any]):
        self._runner = runner
        self._snapshot = snapshot
        self.view: Optional[Any] = None

    def run_async(self, **kwargs):
        self.view = self._snapshot()
        return self._runner.run_async(**kwargs)


def run_errors(event_queue: asyncio.Queue) -> List[Tuple[Optional[str], str]]:
    """Drain the queue and return (code, message) for each RUN_ERROR event."""
    errors = []
    while not event_queue.empty():
        event = event_queue.get_nowait()
        if isinstance(event, RunErrorEvent):
            errors.append((event.code, event.message))
    return errors
