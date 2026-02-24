"""Agentic Generative UI feature."""

from textwrap import dedent
from typing import Literal

from autogen import ConversableAgent, LLMConfig
from autogen.ag_ui import AGUIStream
from autogen.agentchat import ContextVariables, ReplyResult
from autogen.tools import tool
from fastapi import FastAPI
from pydantic import BaseModel, Field


StepStatus = Literal["pending", "completed"]


class Step(BaseModel):
    """Represents a step in a plan."""

    description: str = Field(description="The description of the step")
    status: StepStatus = Field(
        default="pending",
        description="The status of the step (e.g., pending, completed)",
    )


class Plan(BaseModel):
    """Represents a plan with multiple steps."""

    steps: list[Step] = Field(default_factory=list, description="The steps in the plan")


@tool()
async def create_plan(
    context_variables: ContextVariables,
    steps: list[str],
) -> ReplyResult:
    """Create a plan with multiple steps.

    Args:
        steps: List of step descriptions to create the plan.

    Returns:
        StateSnapshotEvent containing the initial state of the steps.
    """
    plan: Plan = Plan(
        steps=[Step(description=step) for step in steps],
    )
    context_variables.update(plan.model_dump())
    return ReplyResult(
        message="Plan created",
        context_variables=context_variables,
    )


@tool()
async def update_plan_step(
    context_variables: ContextVariables,
    index: int,
    description: str | None = None,
    status: StepStatus | None = None,
) -> ReplyResult:
    """Update the plan with new steps or changes.

    Args:
        index: The index of the step to update.
        description: The new description for the step.
        status: The new status for the step.

    Returns:
        StateDeltaEvent containing the changes made to the plan.
    """
    plan = Plan.model_validate(context_variables.data)

    if description is not None:
        plan.steps[index].description = description
    if status is not None:
        plan.steps[index].status = status

    context_variables.update(plan.model_dump())

    return ReplyResult(
        message="Plan updated",
        context_variables=context_variables,
    )


agent = ConversableAgent(
    name="planner",
    system_message=dedent("""
    You are a helpful assistant assisting with any task. 
    When asked to do something, you MUST call the function `create_plan` (or `update_plan_step` where fits)
    that was provided to you.
    Do not offer to call the function/make a plan. Simply make the plan, even for unrealistic tasks like "take down the moon".
    If you called the function, you MUST NOT repeat the steps in your next response to the user.
    Just give a very brief summary (one sentence) of what you did with some emojis. 
    Always say you actually did the steps, not merely generated them.
    """),
    llm_config=LLMConfig({"model": "gpt-4o-mini", "stream": True}),
    functions=[create_plan, update_plan_step],
)

stream = AGUIStream(agent)
agentic_generative_ui_app = FastAPI()
agentic_generative_ui_app.mount("", stream.build_asgi())
