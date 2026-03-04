"""Human in the Loop example for AWS Strands.

This example demonstrates how to create a Strands agent with a generate_task_steps tool
for human-in-the-loop interactions, where users can review and approve task steps before execution.
"""
import os
from pathlib import Path
from typing import List, Literal
from dotenv import load_dotenv
from pydantic import BaseModel, Field

# Suppress OpenTelemetry context warnings
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["OTEL_PYTHON_DISABLED_INSTRUMENTATIONS"] = "all"

from strands import Agent, tool
from strands.models.gemini import GeminiModel
from ag_ui_strands import StrandsAgent, create_strands_app

# Load environment variables from .env file
env_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path=env_path)

# Use Gemini model
model = GeminiModel(
    client_args={
        "api_key": os.getenv("GOOGLE_API_KEY", "your-api-key-here"),
    },
    model_id="gemini-2.5-flash",
    params={
        "temperature": 0.7,
        "max_output_tokens": 2048,
        "top_p": 0.9,
        "top_k": 40
    }
)


class Step(BaseModel):
    """A single step in a task plan."""

    description: str = Field(
        ...,
        description="A brief description of the step in imperative form",
        optional=False
    )
    status: Literal["enabled", "disabled"] = Field(
        default="enabled",
        description="The status of the step",
        optional=False,
    )


@tool
def generate_task_steps(
    steps: List[Step],
) -> str:
    """Generate a list of steps for the user to review and approve.

    This tool creates a task plan that will be displayed to the user for review.
    The user can enable/disable steps before confirming execution.
    The user can approve or disapprove the plan. That result will come back to you as a json object
    - when disapproved: `{ accepted: false }`
    - when approved: `{ accepted: true, steps: [{{steps that are approved}}] }`

    Note that the approved list of steps comes back, it may not be the entire list.

    Args:
        steps: A list of 10 step objects, each containing a description and status.
               Each step should be brief (a few words) and in imperative form
               (e.g., "Dig hole", "Open door", "Mix ingredients").

    Returns:
        A confirmation message.
    """
    return f"Generated {len(steps)} steps for user review"


strands_agent = Agent(
    model=model,
    tools=[generate_task_steps],
    system_prompt="""You are a task planning assistant specialized in creating clear, actionable step-by-step plans.

**Your Primary Role:**
- Break down any user request into exactly 10 clear, actionable steps
- Generate steps that require human review and approval
- Execute only human-approved steps

**When a user requests help with a task:**
1. ALWAYS use the `generate_task_steps` tool to create a breakdown (default to 10 steps unless told otherwise)
2. Each step must be:
   - Brief (only a few words)
   - In imperative form (e.g., "Dig hole", "Open door", "Mix ingredients")
   - Clear and actionable
   - Logically ordered from start to finish
3. Set all steps to "enabled" status initially
4. After the user reviews the plan:
   - If accepted: Briefly confirm the plan (only include the approved steps) and proceed (don't repeat the steps). Do not ask for more clarifying information.
   - If rejected: Ask what they'd like to change (don't call generate_task_steps again until they provide input)
5. When the user accepts the plan, "execute" the plan by repeating the approved steps in order as if you have just done them. Then let the user know you have completed the plan.
    - example: if the user accepts the steps "Dig hole", "Open door", "Mix ingredients", you would respond with "Digging hole... Opening door... Mixing ingredients..."

**Important:**
- NEVER call `generate_task_steps` twice in a row without user input
- NEVER repeat the list of steps in your response after calling the tool
- DO provide a brief, creative summary of how you would execute the approved steps
""",
)

agui_agent = StrandsAgent(
    agent=strands_agent,
    name="human_in_the_loop",
    description="AWS Strands agent with human-in-the-loop task planning",
)

app = create_strands_app(agui_agent, "/")
