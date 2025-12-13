"""Shared state endpoint for the AG-UI protocol."""

from copy import deepcopy
from typing import Any, Dict, List

from fastapi import Request
from fastapi.responses import StreamingResponse

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
)
from ag_ui.encoder import EventEncoder


DEFAULT_RECIPE_STATE: Dict[str, Any] = {
    "title": "Chef's Special Wrap",
    "skill_level": "Advanced",
    "special_preferences": ["Low Carb", "Spicy"],
    "cooking_time": "15 min",
    "ingredients": [
        {"icon": "🍗", "name": "chicken breast", "amount": "1"},
        {"icon": "🌶️", "name": "chili powder", "amount": "1 tsp"},
        {"icon": "🧂", "name": "Salt", "amount": "a pinch"},
        {"icon": "🥬", "name": "Lettuce leaves", "amount": "handful"},
    ],
    "instructions": [
        "Season chicken with chili powder and salt.",
        "Sear until fully cooked.",
        "Slice and wrap in lettuce.",
    ],
}


def _coerce_to_string(value: Any, fallback: str = "") -> str:
    return str(value) if isinstance(value, str) or isinstance(value, (int, float)) else fallback


def normalize_ingredients(ingredients: Any) -> List[Dict[str, str]]:
    normalized: List[Dict[str, str]] = []
    if isinstance(ingredients, list):
        for item in ingredients:
            if isinstance(item, dict):
                normalized.append(
                    {
                        "icon": _coerce_to_string(item.get("icon"), "🍴") or "🍴",
                        "name": _coerce_to_string(item.get("name")),
                        "amount": _coerce_to_string(item.get("amount")),
                    }
                )
    return normalized or deepcopy(DEFAULT_RECIPE_STATE["ingredients"])


def normalize_string_list(values: Any) -> List[str]:
    normalized: List[str] = []
    if isinstance(values, list):
        for value in values:
            coerced = _coerce_to_string(value)
            if coerced:
                normalized.append(coerced)
    return normalized


def build_state_from_input(input_state: Any) -> Dict[str, Any]:
    """Merge incoming state (if any) with defaults to keep the demo deterministic."""
    recipe_state = deepcopy(DEFAULT_RECIPE_STATE)
    if isinstance(input_state, dict):
        maybe_recipe = input_state.get("recipe")
        if isinstance(maybe_recipe, dict):
            if "title" in maybe_recipe:
                recipe_state["title"] = _coerce_to_string(
                    maybe_recipe.get("title"), recipe_state["title"]
                )
            if "skill_level" in maybe_recipe:
                recipe_state["skill_level"] = _coerce_to_string(
                    maybe_recipe.get("skill_level"), recipe_state["skill_level"]
                )
            if "cooking_time" in maybe_recipe:
                recipe_state["cooking_time"] = _coerce_to_string(
                    maybe_recipe.get("cooking_time"), recipe_state["cooking_time"]
                )
            special_preferences = normalize_string_list(maybe_recipe.get("special_preferences"))
            if special_preferences:
                recipe_state["special_preferences"] = special_preferences
            instructions = normalize_string_list(maybe_recipe.get("instructions"))
            if instructions:
                recipe_state["instructions"] = instructions
            ingredients = normalize_ingredients(maybe_recipe.get("ingredients"))
            if ingredients:
                recipe_state["ingredients"] = ingredients

    return {"recipe": recipe_state}


async def shared_state_endpoint(input_data: RunAgentInput, request: Request):
    """Shared state endpoint"""
    accept_header = request.headers.get("accept")
    encoder = EventEncoder(accept=accept_header)
    state_snapshot = build_state_from_input(getattr(input_data, "state", None))

    async def event_generator():
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

        async for event in send_state_events(state_snapshot):
            yield encoder.encode(event)

        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            ),
        )

    return StreamingResponse(event_generator(), media_type=encoder.get_content_type())


async def send_state_events(state):
    """Send state events with recipe data"""
    yield StateSnapshotEvent(
        type=EventType.STATE_SNAPSHOT,
        snapshot=state,
    )
