"""A Pydantic AI agent served over AG-UI with `AGUIAdapter`.

`change_background` and `approve_plan` are not defined here: the frontend
sends them with each run, and Pydantic AI hands those calls back to it.
"""

from __future__ import annotations

import os

import uvicorn
from ag_ui.core import EventType, StateSnapshotEvent
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic_ai import Agent, RunContext, ToolReturn
from pydantic_ai.ui import StateDeps
from pydantic_ai.ui.ag_ui import AGUIAdapter
from starlette.requests import Request
from starlette.responses import Response

load_dotenv()

from shared import INSTRUCTIONS, MODEL, Task, TaskState, lookup_weather

agent = Agent(MODEL, deps_type=StateDeps[TaskState], instructions=INSTRUCTIONS)


@agent.tool_plain
def get_weather(location: str) -> dict:
    """Get the current weather for a location."""
    return lookup_weather(location)


def snapshot(state: TaskState, message: str) -> ToolReturn:
    return ToolReturn(
        return_value=message,
        metadata=StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT, snapshot=state.model_dump()
        ),
    )


@agent.tool
def get_tasks(ctx: RunContext[StateDeps[TaskState]]) -> list[Task]:
    """Get the shared task list, including the user's latest edits."""
    return ctx.deps.state.tasks


@agent.tool
def add_tasks(ctx: RunContext[StateDeps[TaskState]], titles: list[str]) -> ToolReturn:
    """Add tasks to the shared task list."""
    return snapshot(ctx.deps.state, ctx.deps.state.add(titles))


@agent.tool
def set_task_done(
    ctx: RunContext[StateDeps[TaskState]], title: str, done: bool
) -> ToolReturn:
    """Mark a task as done or not done."""
    return snapshot(ctx.deps.state, ctx.deps.state.set_done(title, done))


app = FastAPI(title="Pydantic AI AG-UI agent")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


@app.post("/")
async def run_agent(request: Request) -> Response:
    # dispatch_request copies the request's state into deps.state, so each
    # request gets its own deps.
    return await AGUIAdapter.dispatch_request(
        request, agent=agent, deps=StateDeps(TaskState())
    )


def main() -> None:
    uvicorn.run(
        app, host=os.getenv("HOST", "0.0.0.0"), port=int(os.getenv("PORT", "8105"))
    )


if __name__ == "__main__":
    main()
