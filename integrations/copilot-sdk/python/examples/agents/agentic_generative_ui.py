"""Steps stream into ``state.steps`` while the model writes them (PredictState);
the handler then "executes" them with committed STATE_SNAPSHOTs."""

import asyncio
from typing import Any

from ag_ui_copilot_sdk import AGUITool, CopilotAgent, ToolContext

from .base import define_agent

INSTRUCTIONS = """You are a helpful assistant assisting with any task.
When asked to do something, you MUST call the function `generate_task_steps` that was provided to you.
If you called the function, you MUST NOT repeat the steps in your next response to the user.
Just give a very brief summary (one sentence) of what you did with some emojis.
Always say you actually did the steps, not merely generated them."""


async def generate_task_steps(args: dict[str, Any], ctx: ToolContext) -> str:
    steps = [{**step, "status": "pending"} for step in args["steps"]]
    ctx.set_state({"steps": steps})
    for step in steps:
        await asyncio.sleep(1)
        step["status"] = "completed"
        ctx.set_state({"steps": steps})
    return "Steps executed."


def create_agentic_generative_ui_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="agentic_generative_ui",
        instructions=INSTRUCTIONS,
        predict_state=[
            {"state_key": "steps", "tool": "generate_task_steps", "tool_argument": "steps"}
        ],
        tools=[
            AGUITool(
                name="generate_task_steps",
                skip_permission=True,
                description=(
                    "Make up 10 steps (only a couple of words per step) that are required for a task. "
                    "The step should be in gerund form (i.e. Digging hole, opening door, ...)"
                ),
                parameters={
                    "type": "object",
                    "properties": {
                        "steps": {
                            "type": "array",
                            "description": "An array of 10 step objects, each containing text and status",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "description": {
                                        "type": "string",
                                        "description": "The text of the step in gerund form",
                                    },
                                    "status": {
                                        "type": "string",
                                        "enum": ["pending"],
                                        "description": "Always 'pending'",
                                    },
                                },
                                "required": ["description", "status"],
                            },
                        }
                    },
                    "required": ["steps"],
                },
                handler=generate_task_steps,
            )
        ],
    )
