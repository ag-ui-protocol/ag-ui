"""Human in the Loop feature using OpenResponses."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ag_ui_openresponses import create_openresponses_proxy

CONFIGS_DIR = str(Path(__file__).resolve().parent.parent / "configs")

SYSTEM_PROMPT = (
    "You are a collaborative planning assistant. "
    "When planning tasks use tools only, without any other messages. "
    "IMPORTANT: "
    "- Use the `generate_task_steps` tool to display the suggested steps to the user "
    "- Do not call the `generate_task_steps` twice in a row, ever. "
    "- Never repeat the plan, or send a message detailing steps "
    "- If accepted, the tool result contains ONLY the steps the user approved. "
    "Respond as though you have already executed those steps: list each one (numbered) in past tense and state the total. "
    "Do NOT include steps that were removed by the user. "
    "- If not accepted, ask the user for more information, DO NOT use the `generate_task_steps` tool again "
    "- When generating steps, always set the status field to 'enabled' so the user can review and deselect as needed"
)

app = APIRouter()

create_openresponses_proxy(app, path="/", config_dir=CONFIGS_DIR, system_prompt=SYSTEM_PROMPT)
