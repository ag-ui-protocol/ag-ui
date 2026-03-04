"""Agentic Generative UI example for AWS Strands.

Demonstrates streaming agent state updates to the frontend for real-time UI rendering.
"""
import json
import os
import asyncio
import random
import uuid
from typing import List, Dict, Any, Annotated
from pathlib import Path
from dotenv import load_dotenv
from pydantic import BaseModel, Field

from strands import Agent, tool
from strands.models.gemini import GeminiModel
from ag_ui.core import (
    EventType,
    StateSnapshotEvent,
    StateDeltaEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    MessagesSnapshotEvent,
    AssistantMessage,
)
from ag_ui_strands import (
    StrandsAgent,
    create_strands_app,
    StrandsAgentConfig,
    ToolBehavior,
    PredictStateMapping,
)

# Suppress OpenTelemetry warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

# Load environment variables
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Use Gemini model
model = GeminiModel(
    client_args={
        "api_key": os.getenv("GOOGLE_API_KEY", "your-api-key-here"),
    },
    model_id="gemini-2.5-flash",
    params={
        "temperature": 0.3,
        "max_output_tokens": 1024,
        "top_p": 0.9,
        "top_k": 40
    }
)


class TaskStep(BaseModel):
    """Represents a single UI step."""

    description: str = Field(description="Gerund phrase describing the action, e.g. 'Sketching layout'")
    status: str = Field(description="Must be 'pending' when proposed", default="pending")


@tool
def plan_task_steps(
    task: str,
    context: str = "",
    steps: Annotated[List[Any], Field(description="4-6 pending steps in gerund form")] = None,
) -> Dict[str, Any]:
    """
    Plan the concrete steps required to accomplish a task.

    Args:
        task: Brief description of what the user wants to achieve.
        context: Optional additional instructions or constraints from the user.
        steps: Ordered list of pending steps in gerund form.

    Returns:
        JSON payload with the task summary and proposed steps.
    """
    normalized_steps = _normalize_steps(steps) if steps else []
    if not normalized_steps:
        normalized_steps = _fallback_steps(task or "the task", context)

    return {
        "task": task,
        "context": context,
        "steps": normalized_steps,
    }


def _normalize_steps(raw_steps: Any) -> List[Dict[str, str]]:
    if not isinstance(raw_steps, list):
        return []
    normalized = []
    for step in raw_steps:
        if isinstance(step, TaskStep):
            normalized.append(step.model_dump())
        elif isinstance(step, dict) and "description" in step:
            normalized.append(
                {
                    "description": str(step["description"]),
                    "status": step.get("status") or "pending",
                }
            )
        elif isinstance(step, str) and step.strip():
            normalized.append({"description": step.strip(), "status": "pending"})
    return normalized


def _fallback_steps(task: str, context: str) -> List[Dict[str, str]]:
    """Create a simple deterministic plan when the model forgets to provide steps."""
    count = 6
    for token in context.split():
        if token.isdigit():
            count = max(4, min(10, int(token)))
            break

    templates = [
        "Clarifying goals for {task}",
        "Gathering resources for {task}",
        "Preparing workspace for {task}",
        "Executing core work on {task}",
        "Reviewing results for {task}",
        "Wrapping up {task}",
        "Documenting learnings from {task}",
        "Celebrating completion of {task}",
    ]

    plan = []
    for i in range(count):
        template = templates[i % len(templates)]
        plan.append(
            {
                "description": template.format(task=task).strip().capitalize(),
                "status": "pending",
            }
        )
    return plan


async def steps_state_from_result(context):
    result = context.result_data or {}
    steps = _normalize_steps(result.get("steps"))
    if not steps:
        return None
    return {"steps": steps}


async def simulate_progress(context):
    """Emit incremental state updates to mimic backend work."""
    result = context.result_data or {}
    steps = _normalize_steps(result.get("steps"))
    if not steps:
        return

    working_steps = [dict(step) for step in steps]

    # Initial snapshot (all pending)
    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot={"steps": working_steps},
    )

    for index, _ in enumerate(working_steps):
        # Mark current step as in_progress then completed
        await asyncio.sleep(random.uniform(0.3, 0.8))
        working_steps[index]["status"] = "in_progress"
        yield StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=[
                {
                    "op": "replace",
                    "path": f"/steps/{index}/status",
                    "value": "in_progress",
                }
            ],
        )

        await asyncio.sleep(random.uniform(0.4, 1.0))
        working_steps[index]["status"] = "completed"
        yield StateDeltaEvent(
            type=EventType.STATE_DELTA,
            delta=[
                {
                    "op": "replace",
                    "path": f"/steps/{index}/status",
                    "value": "completed",
                }
            ],
        )

    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot={"steps": working_steps},
    )

    # Emit a lightweight assistant confirmation so the UI always shows completion text
    summary = result.get("task") or "your task"
    message_id = str(uuid.uuid4())
    text = f"The plan for {summary} has been completed successfully."

    yield TextMessageStartEvent(
        type=EventType.TEXT_MESSAGE_START,
        message_id=message_id,
        role="assistant",
    )
    yield TextMessageContentEvent(
        type=EventType.TEXT_MESSAGE_CONTENT,
        message_id=message_id,
        delta=text + " ✅",
    )
    yield TextMessageEndEvent(
        type=EventType.TEXT_MESSAGE_END,
        message_id=message_id,
    )

    # Persist the summary in the timeline so the UI keeps it
    assistant_msg = AssistantMessage(
        id=message_id,
        role="assistant",
        content=text,
    )
    yield MessagesSnapshotEvent(
        type=EventType.MESSAGES_SNAPSHOT,
        messages=list(context.input_data.messages) + [assistant_msg],
    )


def build_state_context(input_data, user_message: str) -> str:
    """Augment the user message with existing plan context to discourage replanning."""
    state = getattr(input_data, "state", {}) or {}
    steps = state.get("steps")
    if steps:
        steps_json = json.dumps(steps, indent=2)
        return (
            "A plan is already in progress. NEVER call plan_task_steps again unless the user explicitly "
            "asks to restart. Discuss progress or ask clarifying questions instead.\n\n"
            f"Current steps:\n{steps_json}\n\nUser: {user_message}"
        )
    return user_message


generative_ui_config = StrandsAgentConfig(
    state_context_builder=build_state_context,
    tool_behaviors={
        "plan_task_steps": ToolBehavior(
            predict_state=[
                PredictStateMapping(
                    state_key="steps",
                    tool="plan_task_steps",
                    tool_argument="steps",
                )
            ],
            state_from_result=steps_state_from_result,
            custom_result_handler=simulate_progress,
            stop_streaming_after_result=True,
        )
    }
)


system_prompt = """
You are an energetic project assistant who decomposes user goals into action plans.

Planning rules:
1. When the user asks for help with a task or making a plan, call `plan_task_steps` exactly once to create the plan.
2. Do NOT call `plan_task_steps` again unless the user explicitly says to restart or discard the plan (or moves on to a new task).
3. Generate 4-6 concise steps in gerund form (e.g., “Setting up repo”, “Testing prototype”) and leave their status as "pending".
4. After the tool call, send a short confirmation (<= 2 sentences) plus one emoji describing what you planned.
5. If the user is just chatting or reviewing progress, respond conversationally and DO NOT call the tool.
6. If a plan already exists, reference the current steps and ask follow-up questions instead of creating a new plan, unless instructed otherwise.
"""


strands_agent = Agent(
    model=model,
    tools=[plan_task_steps],
    system_prompt=system_prompt,
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="agentic_generative_ui",
    description="AWS Strands agent with generative UI and state streaming",
    config=generative_ui_config,
)

app = create_strands_app(agui_agent, "/")
