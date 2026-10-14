"""Shared state: the agent and the page edit the same recipe.

The page keeps a `recipe` in AG-UI shared state and writes the user's edits
back with `agent.setState`. The agent writes it with a server tool that calls
`experimental_set_state()`, which streams a STATE_SNAPSHOT the page renders at
once. It reads it back through the adapter's built-in `get_shared_state` tool,
which `experimental_app_state=True` turns on: Antigravity fixes the
instructions for the whole session, so the state cannot be folded into the
prompt on each run the way other integrations do it.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from ag_ui_antigravity import experimental_get_state, experimental_set_state

from ._common import build, chat_only_capabilities


def generate_recipe(
    title: str,
    skill_level: str,
    ingredients: List[Dict[str, str]],
    instructions: List[str],
    cooking_time: Optional[str] = None,
    special_preferences: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Creates or replaces the recipe shown in the app.

    Always pass the complete recipe, including what is already there.

    Args:
      title: The recipe's title.
      skill_level: One of Beginner, Intermediate or Advanced.
      ingredients: Every ingredient, each with an emoji "icon", a "name" and an
        "amount".
      instructions: Every step, in order.
      cooking_time: One of 5 min, 15 min, 30 min, 45 min or 60+ min.
      special_preferences: Dietary preferences, such as Vegetarian.
    """
    state = experimental_get_state()
    recipe = dict(state.get("recipe") or {})
    recipe.update(
        {
            "title": title,
            "skill_level": skill_level,
            "ingredients": ingredients,
            "instructions": instructions,
        }
    )
    if cooking_time:
        recipe["cooking_time"] = cooking_time
    if special_preferences is not None:
        recipe["special_preferences"] = special_preferences
    experimental_set_state({**state, "recipe": recipe})
    return {"status": "success", "message": "Recipe updated."}


agent = build(
    capabilities=chat_only_capabilities(),
    tools=[generate_recipe],
    experimental_app_state=True,
    system_instructions=(
        "You help the user build a recipe that is shown in the app next to "
        "this chat. The user can edit it there at any time, so call "
        "get_shared_state before answering anything about the current recipe. "
        "To create or change the recipe, call generate_recipe with the complete "
        "recipe, then confirm in one short sentence."
    ),
)
