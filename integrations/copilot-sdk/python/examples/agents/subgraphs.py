"""Native task calls own the subagent lifecycle; tools only publish travel state."""

import json
from typing import Any

from ag_ui_copilot_sdk import AGUITool, CopilotAgent, ToolContext

from .base import define_agent

CATALOG = {
    "flights": [
        {"airline": "KLM", "departure": "Amsterdam (AMS)", "arrival": "San Francisco (SFO)", "price": "$650", "duration": "11h 30m"},
        {"airline": "United", "departure": "Amsterdam (AMS)", "arrival": "San Francisco (SFO)", "price": "$720", "duration": "12h 15m"},
    ],
    "hotels": [
        {"name": "Hotel Zephyr", "location": "Fisherman's Wharf", "price_per_night": "$280/night", "rating": "4.2 stars"},
        {"name": "The Ritz-Carlton", "location": "Nob Hill", "price_per_night": "$550/night", "rating": "4.8 stars"},
        {"name": "Hotel Zoe", "location": "Union Square", "price_per_night": "$320/night", "rating": "4.4 stars"},
    ],
    "experiences": [
        {"name": "Pier 39", "type": "activity", "description": "Waterfront shops and sea lions", "location": "Fisherman's Wharf"},
        {"name": "Golden Gate Bridge", "type": "activity", "description": "Walk across the iconic suspension bridge", "location": "Golden Gate"},
        {"name": "Swan Oyster Depot", "type": "restaurant", "description": "Fresh oysters at a historic seafood counter", "location": "Polk Street"},
        {"name": "Tartine Bakery", "type": "restaurant", "description": "Artisanal bread and pastries", "location": "Mission District"},
    ],
}
OPTION_SCHEMA = {"type": "object", "additionalProperties": {"type": "string"}}


def travel_state(args: dict[str, Any], ctx: ToolContext) -> str:
    agent, selection = args["agent"], args.get("selection")
    options = CATALOG[agent]
    state = ctx.state or {}
    itinerary = {**(state.get("itinerary") or {})}
    if selection is not None:
        choice = next((o for o in options if o.get("airline", o.get("name")) == selection), None)
        if choice is None or agent == "experiences":
            raise ValueError("Choose an offered flight or hotel")
        itinerary["flight" if agent == "flights" else "hotel"] = choice
    ctx.set_state({**state, "itinerary": itinerary, agent: options, "active_agent": agent,
                   "planning_step": "complete" if agent == "experiences" else agent})
    if selection is not None:
        return json.dumps({"agent": agent, "selection": selection, "saved": True})
    if agent == "experiences":
        return json.dumps({"agent": agent, "experiences": options})
    return json.dumps({
        "agent": agent,
        "message": f"Choose from these {agent} for the Amsterdam–San Francisco demo (no booking).",
        "options": options,
        "recommendation": options[0 if agent == "flights" else 2],
    })


def resume_choice(payload: Any, args: dict[str, Any]) -> dict[str, str]:
    agent = args["agent"]
    answer = json.loads(payload) if isinstance(payload, str) else payload
    key = "airline" if agent == "flights" else "name"
    if (agent not in ("flights", "hotels") or not isinstance(answer, dict)
            or not any(o[key] == answer.get(key) for o in CATALOG[agent])):
        raise ValueError("Choose an offered flight or hotel")
    return {"agent": agent, "selection": answer[key]}


def create_subgraphs_agent(client: Any) -> CopilotAgent:
    return define_agent(
        client, name="subgraphs",
        instructions="""You are the Copilot SDK travel supervisor. This is a static Amsterdam–San Francisco demo, not a booking service.
For a travel request, delegate sequentially using the native task tool to flights_agent, then hotels_agent, then experiences_agent.
Each task MUST use agent_type, a short name, description, prompt, and mode="sync". Wait for each task to finish before starting the next.
Never choose flights or hotels yourself or call their tools directly. Relay the final itinerary briefly; nothing is booked.""",
        tools=[
            AGUITool(
                name="travel_state",
                description="Find demo options, or save the user's selection by airline/hotel name.",
                parameters={"type": "object", "properties": {
                    "agent": {"type": "string", "enum": list(CATALOG)},
                    "selection": {"type": "string"},
                }, "required": ["agent"]},
                handler=travel_state,
                skip_permission=True,
            ),
            AGUITool(
                name="choose_travel_option",
                description="Pause for the user to select a flight or hotel. Copy the search result unchanged.",
                parameters={"type": "object", "properties": {
                    "agent": {"type": "string", "enum": ["flights", "hotels"]},
                    "message": {"type": "string"},
                    "options": {"type": "array", "items": OPTION_SCHEMA},
                    "recommendation": OPTION_SCHEMA,
                }, "required": ["agent", "message", "options", "recommendation"]},
            ),
        ],
        interrupts={"choose_travel_option": resume_choice},
        session_options={"custom_agents": [
            {
                "name": f"{agent}_agent", "display_name": f"{agent.title()} Agent",
                "description": f"Handles {agent} for the travel itinerary.",
                "tools": ["travel_state"] if agent == "experiences" else ["travel_state", "choose_travel_option"],
                "prompt": (
                    f"You are the Copilot SDK travel specialist: {agent}.\n"
                    f'First call travel_state with agent="{agent}" and no selection.\n'
                    + ("Summarize the returned activities and restaurants." if agent == "experiences" else
                       "Call choose_travel_option with the entire returned JSON unchanged.\n"
                       "Wait for the user's decision. Then call travel_state with "
                       f'agent="{agent}" and exactly the selection returned by the interrupt.\n'
                       "Only after saving, confirm the selection. Never choose on behalf of the user.")
                    + "\nThese are static demo options, not real bookings."
                ),
            }
            for agent in CATALOG
        ]},
    )
