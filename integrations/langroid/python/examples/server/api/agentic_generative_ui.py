"""Agentic Generative UI example for Langroid.

This example demonstrates dynamic UI generation using AG-UI state events.
The agent creates plans with steps and updates their status dynamically.
"""
import json
import os
from pathlib import Path
from textwrap import dedent
from typing import Any, Literal, Optional
from dotenv import load_dotenv

env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

import langroid as lr
from langroid.agent import ToolMessage, ChatAgent
from pydantic import BaseModel, Field
from ag_ui.core import EventType, StateSnapshotEvent, StateDeltaEvent
from ag_ui_langroid import LangroidAgent, create_langroid_app

StepStatus = Literal['pending', 'completed']


class Step(BaseModel):
    """Represents a step in a plan."""

    description: str = Field(description='The description of the step')
    status: StepStatus = Field(
        default='pending',
        description='The status of the step (e.g., pending, completed)',
    )


class Plan(BaseModel):
    """Represents a plan with multiple steps."""

    steps: list[Step] = Field(default_factory=list, description='The steps in the plan')


class JSONPatchOp(BaseModel):
    """A class representing a JSON Patch operation (RFC 6902)."""

    op: Literal['add', 'remove', 'replace', 'move', 'copy', 'test'] = Field(
        description='The operation to perform: add, remove, replace, move, copy, or test',
    )
    path: str = Field(description='JSON Pointer (RFC 6901) to the target location')
    value: Any = Field(
        default=None,
        description='The value to apply (for add, replace operations)',
    )
    from_: str | None = Field(
        default=None,
        alias='from',
        description='Source path (for move, copy operations)',
    )


class CreatePlanTool(ToolMessage):
    """Create a plan with multiple steps."""
    request: str = "create_plan"
    purpose: str = """
        Create a plan with multiple steps.
        Use this when the user asks you to create a plan or break down a task into steps.
        This sets the initial state of the steps.
    """
    steps: list[str]


class UpdatePlanStepTool(ToolMessage):
    """Update the status or description of a step in the plan."""
    request: str = "update_plan_step"
    purpose: str = """
        Update the status or description of a specific step in the plan.
        Use this to mark steps as completed or update their descriptions.
        The index is 0-based.
    """
    index: int
    description: Optional[str] = None
    status: Optional[StepStatus] = None


# Configure LLM
llm_config = lr.language_models.OpenAIGPTConfig(
    chat_model=lr.language_models.OpenAIChatModel.GPT4o,
    api_key=os.getenv("OPENAI_API_KEY"),
    # Make behavior deterministic for demos and e2e tests
    temperature=0.0,
)

agent_config = lr.ChatAgentConfig(
    name="PlanAssistant",
    llm=llm_config,
    system_message=dedent("""
        You are a helpful assistant that can create plans with multiple steps.

        CRITICAL RULES - YOU MUST FOLLOW THESE EXACTLY:
        1. When the user asks you to create a plan, make a plan, or break down a task into steps, you MUST IMMEDIATELY call the `create_plan` tool. Do NOT respond with text first.
        2. NEVER say you have "already created" a plan unless you have actually called the `create_plan` tool in this conversation.
        3. NEVER describe steps in your text response - the `create_plan` tool will handle displaying the steps.
        4. The `create_plan` tool requires a `steps` parameter which is a list of step descriptions as strings.
        5. After calling `create_plan`, provide a brief summary (1-2 sentences with emojis) of what you did.
        6. Use `update_plan_step` ONLY when the user explicitly asks to modify an existing plan's steps.
        
        Examples:
        - User: "give me a plan to make brownies" → You MUST call create_plan with steps like ["Gather ingredients", "Mix batter", "Bake", etc.]
        - User: "Go to Mars" → You MUST call create_plan with steps for a Mars mission
        - User: "mark step 3 as complete" → Use update_plan_step to update the status
    """),
    use_tools=True,
    use_functions_api=False,
)


class PlanAssistantAgent(ChatAgent):
    """ChatAgent with plan management tool handlers that return AG-UI events."""
    
    def __init__(self, config):
        super().__init__(config)
        self._plan_data = None
        self._last_step_update = None
    
    def create_plan(self, msg: CreatePlanTool) -> str:
        """
        Handle create_plan tool execution.
        Creates plan and returns result. State events will be handled by handler method.
        Returns string result for Langroid to continue processing.
        Note: Don't include steps in the return value - the handler will emit them via STATE_SNAPSHOT.
        This prevents the frontend from creating a duplicate component from the tool result.
        """
        plan = Plan(
            steps=[Step(description=step) for step in msg.steps],
        )
        self._plan_data = plan.model_dump()
        # Return simple confirmation without steps - handler will emit STATE_SNAPSHOT
        # This matches LangGraph's pattern of returning "Steps executed." without the steps
        return json.dumps({"status": "plan_created", "steps_count": len(msg.steps)})
    
    def update_plan_step(
        self, msg: UpdatePlanStepTool
    ) -> str:
        """
        Handle update_plan_step tool execution.
        Updates step and returns result. State events will be handled by handler method.
        Returns string result for Langroid to continue processing.
        """
        self._last_step_update = {
            "index": msg.index,
            "description": msg.description,
            "status": msg.status
        }
        status_msg = f"updated step {msg.index}"
        if msg.status:
            status_msg += f" to {msg.status}"
        return json.dumps({"status": "step_updated", "index": msg.index, "message": status_msg})
    
    async def _handle_create_plan_result(self, result_data: dict):
        """
        Handler for create_plan tool result - emits state events.
        Automatically processes all steps and emits state deltas.
        Uses self._plan_data which was set during create_plan execution.
        """
        import asyncio
        import random
        
        # Get steps from _plan_data (set during create_plan) instead of result_data
        # This allows us to return a simple tool result without steps to prevent duplicate components
        if not hasattr(self, "_plan_data") or not self._plan_data:
            return
        
        steps = self._plan_data.get("steps", [])
        if not steps:
            return
        
        working_steps = []
        for step in steps:
            if isinstance(step, dict):
                step_dict = dict(step)
                if "status" not in step_dict:
                    step_dict["status"] = "pending"
                working_steps.append(step_dict)
            else:
                working_steps.append({"description": str(step), "status": "pending"})
        
        yield StateSnapshotEvent(
            type=EventType.STATE_SNAPSHOT,
            snapshot={"steps": working_steps},
        )
        
        for index, _ in enumerate(working_steps):
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
    
    async def _handle_update_plan_step_result(self, result_data: dict):
        """
        Handler for update_plan_step tool result - emits state delta event.
        """
        if not hasattr(self, "_last_step_update"):
            return
        
        update = self._last_step_update
        changes = []
        
        if update.get("description") is not None:
            changes.append({
                "op": "replace",
                "path": f"/steps/{update['index']}/description",
                "value": update["description"],
            })
        if update.get("status") is not None:
            changes.append({
                "op": "replace",
                "path": f"/steps/{update['index']}/status",
                "value": update["status"],
            })
        
        if changes:
            yield StateDeltaEvent(
                type=EventType.STATE_DELTA,
                delta=changes,
            )


chat_agent = PlanAssistantAgent(agent_config)
chat_agent.enable_message(CreatePlanTool)
chat_agent.enable_message(UpdatePlanStepTool)

task = lr.Task(
    chat_agent,
    name="PlanAssistant",
    interactive=False,
    single_round=False,
)

agui_agent = LangroidAgent(
    agent=task,
    name="agentic_generative_ui",
    description="Langroid agent with agentic generative UI support - dynamic plan creation and step updates",
)

app = create_langroid_app(agui_agent, "/")

