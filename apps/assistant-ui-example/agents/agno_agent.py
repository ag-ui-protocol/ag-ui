"""An Agno agent served over AG-UI with AgentOS and the `AGUI` interface.

The frontend sends `change_background` and `approve_plan` with each run; Agno
pauses on those calls and resumes when their results come back.
"""

from __future__ import annotations

import os

import uvicorn
from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI
from agno.run import RunContext
from dotenv import load_dotenv
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

from shared import INSTRUCTIONS, MODEL, TaskState, lookup_weather


def get_weather(location: str) -> dict:
    """Get the current weather for a location."""
    return lookup_weather(location)


def get_tasks(run_context: RunContext) -> list[dict]:
    """Get the shared task list, including the user's latest edits."""
    state = TaskState.model_validate(run_context.session_state or {})
    return state.model_dump()["tasks"]


def add_tasks(run_context: RunContext, titles: list[str]) -> str:
    """Add tasks to the shared task list."""
    state = TaskState.model_validate(run_context.session_state or {})
    message = state.add(titles)
    run_context.session_state["tasks"] = state.model_dump()["tasks"]
    return message


def set_task_done(run_context: RunContext, title: str, done: bool) -> str:
    """Mark a task as done or not done."""
    state = TaskState.model_validate(run_context.session_state or {})
    message = state.set_done(title, done)
    run_context.session_state["tasks"] = state.model_dump()["tasks"]
    return message


agent = Agent(
    db=InMemoryDb(),
    model=MODEL,
    tools=[get_weather, get_tasks, add_tasks, set_task_done],
    instructions=INSTRUCTIONS,
    session_state={"tasks": []},
    # The AG-UI router passes only the latest user message, so earlier turns
    # come from the agent's own session history.
    add_history_to_context=True,
    num_history_runs=10,
    markdown=True,
)

agent_os = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)])
app = agent_os.get_app()
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


def main() -> None:
    uvicorn.run(
        app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8115"))
    )


if __name__ == "__main__":
    main()
