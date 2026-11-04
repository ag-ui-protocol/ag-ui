"""Subgraphs: a travel supervisor delegating to flights, hotels and experiences.

The reference is LangGraph's travel supervisor, whose sub-agents are subgraphs.
Here the Antigravity agent is the supervisor and each sub-agent is a server
tool it calls in turn. A sub-agent

* marks itself as the active agent and publishes what it found, by writing the
  page's shared state with `experimental_set_state()`;
* for flights and hotels, pauses on the user with `experimental_interrupt()` so they can
  pick an option, then records the pick in `itinerary`.

The page reads `flights`, `hotels`, `experiences`, `itinerary` and
`active_agent` from state. Its interrupt card destructures `message`,
`options`, `recommendation` and `agent` from the interrupt itself, so they are
passed as top-level interrupt fields, and it resolves with the chosen option
as a JSON *string*, which is parsed here.

The sub-agents make no model call of their own: in the reference only the
experiences subgraph does, to phrase its findings, and the supervisor does that
here from the tool's result.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from ag_ui_antigravity import (
    experimental_get_state,
    experimental_interrupt,
    experimental_set_state,
)

from ._common import build, chat_only_capabilities

FLIGHTS: List[Dict[str, str]] = [
    {
        "airline": "KLM",
        "departure": "Amsterdam (AMS)",
        "arrival": "San Francisco (SFO)",
        "price": "$650",
        "duration": "11h 30m",
    },
    {
        "airline": "United",
        "departure": "Amsterdam (AMS)",
        "arrival": "San Francisco (SFO)",
        "price": "$720",
        "duration": "12h 15m",
    },
]

HOTELS: List[Dict[str, str]] = [
    {
        "name": "Hotel Zephyr",
        "location": "Fisherman's Wharf",
        "price_per_night": "$280/night",
        "rating": "4.2 stars",
    },
    {
        "name": "The Ritz-Carlton",
        "location": "Nob Hill",
        "price_per_night": "$550/night",
        "rating": "4.8 stars",
    },
    {
        "name": "Hotel Zoe",
        "location": "Union Square",
        "price_per_night": "$320/night",
        "rating": "4.4 stars",
    },
]

EXPERIENCES: List[Dict[str, str]] = [
    {
        "name": "Swan Oyster Depot",
        "type": "restaurant",
        "description": "Historic seafood counter serving fresh oysters",
        "location": "Polk Street",
    },
    {
        "name": "Tartine Bakery",
        "type": "restaurant",
        "description": "Artisanal bakery famous for bread and pastries",
        "location": "Mission District",
    },
    {
        "name": "Pier 39",
        "type": "activity",
        "description": "Iconic waterfront destination with shops and sea lions",
        "location": "Fisherman's Wharf",
    },
    {
        "name": "Golden Gate Bridge",
        "type": "activity",
        "description": "World-famous suspension bridge with stunning views",
        "location": "Golden Gate",
    },
]


def _update_state(**changes: Any) -> Dict[str, Any]:
    """Merges ``changes`` into the shared state and streams it to the page."""
    state = experimental_get_state()
    state.update(changes)
    experimental_set_state(state)
    return state


def _set_itinerary(key: str, value: Dict[str, Any]) -> None:
    state = experimental_get_state()
    itinerary = dict(state.get("itinerary") or {})
    itinerary[key] = value
    experimental_set_state({**state, "itinerary": itinerary})


def _chosen_option(
    payload: Any, options: List[Dict[str, str]], key: str
) -> Optional[Dict[str, str]]:
    """The option the page sent back, matched against the offered ones.

    The page resolves with ``JSON.stringify(option)``; a client that sends the
    object itself is accepted too. Only an offered option counts, so a stray
    payload cannot book something that was never on the list.
    """
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except ValueError:
            return None
    if not isinstance(payload, dict):
        return None
    for option in options:
        if option[key] == payload.get(key):
            return option
    return None


async def flights_agent(origin: str, destination: str) -> str:
    """The flights sub-agent: finds flights and has the user pick one.

    Args:
      origin: Where the trip starts, e.g. "Amsterdam".
      destination: Where the trip goes, e.g. "San Francisco".
    """
    # The options travel in the interrupt; the state gets the list once the
    # user has chosen, as in the LangGraph reference (the page shows both).
    _update_state(active_agent="flights", planning_step="flights")
    recommendation = FLIGHTS[0]
    answer = await experimental_interrupt(
        "flights",
        message=(
            f"Found {len(FLIGHTS)} flight options from {origin} to {destination}. "
            f"I recommend choosing the flight by {recommendation['airline']} "
            "since it's known to be on time and cheaper."
        ),
        # In metadata, not as extra top-level fields: CopilotKit's runtime
        # relays only the protocol's own interrupt fields.
        metadata={
            "options": FLIGHTS,
            "recommendation": recommendation,
            "agent": "flights",
        },
    )
    chosen = _chosen_option(answer.payload, FLIGHTS, "airline") if answer.resolved else None
    if chosen is None:
        return f"Flights Agent: No flight was chosen ({answer.status}), so none is booked."
    _update_state(flights=FLIGHTS)
    _set_itinerary("flight", chosen)
    return (
        f"Flights Agent: Great. I'll book you the {chosen['airline']} flight "
        f"from {chosen['departure']} to {chosen['arrival']}."
    )


async def hotels_agent(destination: str) -> str:
    """The hotels sub-agent: finds hotels and has the user pick one.

    Args:
      destination: The city to stay in, e.g. "San Francisco".
    """
    _update_state(active_agent="hotels", planning_step="hotels")
    recommendation = HOTELS[2]
    answer = await experimental_interrupt(
        "hotels",
        message=(
            f"Found {len(HOTELS)} accommodation options in {destination}. "
            f"I recommend choosing the {recommendation['name']} since it strikes "
            "the balance between rating, price, and location."
        ),
        # In metadata, not as extra top-level fields: CopilotKit's runtime
        # relays only the protocol's own interrupt fields.
        metadata={
            "options": HOTELS,
            "recommendation": recommendation,
            "agent": "hotels",
        },
    )
    chosen = _chosen_option(answer.payload, HOTELS, "name") if answer.resolved else None
    if chosen is None:
        return f"Hotels Agent: No hotel was chosen ({answer.status}), so none is booked."
    _update_state(hotels=HOTELS)
    _set_itinerary("hotel", chosen)
    return f"Hotels Agent: Excellent choice! You'll like {chosen['name']}."


async def experiences_agent(destination: str) -> Dict[str, Any]:
    """The experiences sub-agent: finds restaurants and activities.

    Args:
      destination: The city being visited, e.g. "San Francisco".
    """
    _update_state(
        active_agent="experiences", experiences=EXPERIENCES, planning_step="experiences"
    )
    return {"destination": destination, "experiences": EXPERIENCES}


agent = build(
    capabilities=chat_only_capabilities(),
    tools=[flights_agent, hotels_agent, experiences_agent],
    system_instructions=(
        "You are a travel planning supervisor coordinating three specialist "
        "agents, which you reach as tools. Trips start in Amsterdam unless the "
        "user says otherwise. Delegate one at a time, in this order: "
        "flights_agent, then hotels_agent, then experiences_agent. The flights "
        "and hotels agents ask the user to choose themselves; never ask for a "
        "choice yourself. When all three have reported, summarize the plan for "
        "the user in a few sentences."
    ),
)
