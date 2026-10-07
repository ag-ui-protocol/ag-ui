"""The tool's argument IS the new state: the handler snapshots it for the UI."""

from typing import Any

from ag_ui_copilot_sdk import AGUITool, CopilotAgent, ToolContext

from .base import define_agent

INSTRUCTIONS = """You are a helpful recipe assistant. When asked to improve or modify a recipe:

1. Call the generate_recipe tool ONCE with the COMPLETE updated recipe
2. Include ALL fields: title, skill_level, special_preferences, cooking_time, ingredients, instructions, and changes
3. After calling the tool, respond to the user with a brief confirmation of what you changed (1-2 sentences)
4. Do NOT call the tool multiple times in a row
5. Keep existing elements that aren't being changed

Be creative and helpful!"""

RECIPE_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "The title of the recipe"},
        "skill_level": {"type": "string", "enum": ["Beginner", "Intermediate", "Advanced"]},
        "special_preferences": {"type": "array", "items": {"type": "string"}},
        "cooking_time": {
            "type": "string",
            "enum": ["5 min", "15 min", "30 min", "45 min", "60+ min"],
        },
        "ingredients": {
            "type": "array",
            "description": "Entire list of ingredients, existing and new: icon (emoji like 🥕), name and amount",
            "items": {
                "type": "object",
                "properties": {
                    "icon": {"type": "string"},
                    "name": {"type": "string"},
                    "amount": {"type": "string"},
                },
                "required": ["icon", "name", "amount"],
            },
        },
        "instructions": {"type": "array", "items": {"type": "string"}},
        "changes": {
            "type": "string",
            "description": "A description of the changes made to the recipe",
        },
    },
    "required": [
        "skill_level",
        "special_preferences",
        "cooking_time",
        "ingredients",
        "instructions",
    ],
}


def generate_recipe(args: dict[str, Any], ctx: ToolContext) -> str:
    ctx.set_state({"recipe": args["recipe"]})
    return "Recipe updated successfully"


def create_shared_state_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client,
        name="shared_state",
        instructions=INSTRUCTIONS,
        tools=[
            AGUITool(
                name="generate_recipe",
                skip_permission=True,
                description=(
                    "Using the existing (if any) ingredients and instructions, proceed with the recipe to finish it. "
                    "Make sure the recipe is complete. ALWAYS provide the entire recipe, not just the changes."
                ),
                parameters={
                    "type": "object",
                    "properties": {"recipe": RECIPE_SCHEMA},
                    "required": ["recipe"],
                },
                handler=generate_recipe,
            )
        ],
    )
