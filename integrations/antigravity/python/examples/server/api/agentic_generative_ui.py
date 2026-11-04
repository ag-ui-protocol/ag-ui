"""Agentic generative UI: a plan whose steps complete while the agent works.

The page renders `state.steps` (each `{"description", "status"}`) as a task
list and redraws on every state change. The agent's
`generate_task_steps_generative_ui` server tool writes the plan with
`experimental_set_state()`, which streams a STATE_SNAPSHOT at once, then marks one step
completed at a time, pausing between them, so the page shows the plan
progressing inside a single tool call. The tool's name and argument shape are
the ones the other integrations' demos use.

The pauses are kept short: the harness moves a slow custom tool to a background
task and lets the model carry on without its result.
"""

from __future__ import annotations

import asyncio
from typing import Dict, List

from ag_ui_antigravity import experimental_get_state, experimental_set_state

from ._common import build, chat_only_capabilities

# Seconds between two steps completing.
STEP_DELAY = 0.5


async def generate_task_steps_generative_ui(
    steps: List[Dict[str, str]],
) -> Dict[str, str]:
    """Shows a plan in the app and carries it out step by step.

    Args:
      steps: The plan's steps in order, each with a short "description" in
        the imperative form (e.g. "Book the flights") and a "status" of
        "pending".
    """
    plan = [
        {"description": str(step.get("description", "")), "status": "pending"}
        for step in steps
    ]
    state = experimental_get_state()
    experimental_set_state({**state, "steps": plan})
    for index in range(len(plan)):
        await asyncio.sleep(STEP_DELAY)
        plan[index] = {**plan[index], "status": "completed"}
        experimental_set_state({**state, "steps": [dict(step) for step in plan]})
    return {"status": "completed", "message": f"All {len(plan)} steps are done."}


agent = build(
    capabilities=chat_only_capabilities(),
    tools=[generate_task_steps_generative_ui],
    system_instructions=(
        "You help the user get things done. When they ask for a plan or a "
        "task, call generate_task_steps_generative_ui once with the steps; it "
        "shows them in the app and carries them out. Make the plan even for "
        "unrealistic tasks. Afterwards do not repeat the steps: say in one "
        "short sentence that you completed them. Answer anything else "
        "directly."
    ),
)
