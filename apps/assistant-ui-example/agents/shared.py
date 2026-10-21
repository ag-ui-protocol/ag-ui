"""Pieces shared by both agents, so the frontend sees the same tools either way."""

from __future__ import annotations

import os
from textwrap import dedent

from pydantic import BaseModel, Field

# Any model string both frameworks accept, e.g. "anthropic:claude-haiku-5-5".
MODEL = os.getenv("MODEL", "openai:gpt-4.1-mini")


class Task(BaseModel):
    title: str
    done: bool = False


class TaskState(BaseModel):
    """Agent state shared with the frontend over STATE_SNAPSHOT / STATE_DELTA."""

    tasks: list[Task] = Field(default_factory=list)

    # The agent reads and changes the list through tools rather than seeing it
    # in its instructions, so each call sits in the conversation in order and
    # edits the user made in between are never mistaken for older state.
    def add(self, titles: list[str]) -> str:
        existing = {t.title for t in self.tasks}
        added = []
        for title in titles:
            if title not in existing:
                existing.add(title)
                added.append(title)
                self.tasks.append(Task(title=title))
        return f"Added {', '.join(added)}." if added else "No new tasks to add."

    def set_done(self, title: str, done: bool) -> str:
        for task in self.tasks:
            if task.title == title:
                task.done = done
                return f"Marked {title!r} as {'done' if done else 'not done'}."
        return f"No task named {title!r}."


def lookup_weather(location: str) -> dict:
    """Canned weather so the example runs without another API key."""
    seed = sum(ord(c) for c in location.lower())
    return {
        "location": location,
        "temperature_c": 8 + seed % 22,
        "conditions": ["Sunny", "Partly cloudy", "Overcast", "Light rain"][seed % 4],
        "humidity": 40 + seed % 50,
        "wind_kph": 5 + seed % 25,
    }


INSTRUCTIONS = dedent(
    """
    You are a helpful assistant. Keep replies short.

    - For weather questions, call `get_weather`.
    - To change the page background, call `change_background` with a CSS color
      or gradient. It runs in the user's browser.
    - When asked to plan something, call `approve_plan` with 3 to 6 short steps
      and wait for the user's answer. Then call `add_tasks` with only the
      approved steps. If nothing was approved, ask what to change instead.
    - The task list is shared with the user, who can also add, tick and remove
      tasks at any time. Call `get_tasks` before answering questions about it.
      Call `add_tasks` or `set_task_done` only when the user asks you to change
      it.
    """
)
