"""Human-in-the-loop AgentSpec example for AG-UI."""

from __future__ import annotations

import os

import dotenv

from pyagentspec.agent import Agent
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.property import Property
from pyagentspec.serialization import AgentSpecSerializer
from pyagentspec.tools import ClientTool

dotenv.load_dotenv()


steps_property = Property(
    title="steps",
    json_schema={
        "title": "steps",
        "type": "array",
        "description": (
            'Ordered list of candidate steps awaiting human approval. '
            'Each list element is a dict of two keys, "description" (short imperative command for this step) '
            'and "status" (one of "enabled", "disabled", "executing", must be specified as "enabled" at the beginning)'
        ),
        "items": {
            "type": "object",
            "properties": {
                "description": {
                    "type": "string",
                    "description": "Short imperative command for this step.",
                },
                "status": {
                    "type": "string",
                    "enum": ["enabled", "disabled", "executing"],
                    "description": "The status of the step, it must be specified as 'enabled' at the beginning.",
                },
            },
            "required": ["description", "status"],
            "additionalProperties": False
        },
    },
)


generate_task_steps_tool = ClientTool(
    name="generate_task_steps",
    description=(
        (
            "Generates a list of steps for the user to perform. "
            "The input argument is a list of dicts (steps) with fields `description` and `status`."
            "`description` is a string of a short imperative command for this step, "
            "and `status` is always `enabled` at the beginning. "
            "Make sure `status` is always `enabled` at the beginning so that the user can review."
        )
    ),
    inputs=[steps_property],
)


agent_llm = OpenAiCompatibleConfig(
    name="hitl_llm",
    model_id=os.getenv("OPENAI_MODEL", "gpt-4o"),
    url=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
)


hitl_agent = Agent(
    name="human_in_the_loop_agent",
    description="Task planner that collaborates with a human to approve execution steps.",
    system_prompt=(
        "You are a collaborative planning assistant. "
        "When planning tasks use tools only, without any other messages. "
        "IMPORTANT: "
        "- Use the `generate_task_steps` tool to display the suggested steps to the user "
        "- Do not call the `generate_task_steps` twice in a row, ever. "
        "- Never repeat the plan, or send a message detailing steps "
        "- If accepted, confirm the creation of the plan and the number of selected (enabled) steps only "
        "- If not accepted, ask the user for more information, DO NOT use the `generate_task_steps` tool again "
    ),
    llm_config=agent_llm,
    tools=[generate_task_steps_tool],
)


human_in_the_loop_agent_json = AgentSpecSerializer().to_json(hitl_agent)
