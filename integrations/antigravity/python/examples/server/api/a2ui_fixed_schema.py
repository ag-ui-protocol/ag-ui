"""A2UI fixed schema: the layout is authored ahead of time, the model fills the data.

The dojo page renders against its fixed catalog (Row / FlightCard / HotelCard /
StarRating). The component trees live in ``a2ui_fixed_schema_schemas/`` and
never change; the model only supplies the rows. ``search_flights`` and
``search_hotels`` are plain server tools that return the ``a2ui_operations``
envelope (createSurface -> updateComponents -> updateDataModel). The adapter
JSON-encodes a server tool's return value into ``TOOL_CALL_RESULT``, where the
runtime's A2UI middleware detects the envelope and paints the surface.

The tools are backend-owned on purpose. A ``render_a2ui`` tool injected by the
runtime would arrive as a frontend tool, and Antigravity parks a frontend tool
until a later run carries its result -- nothing would ever answer it here.

The row types are ``TypedDict``s rather than ``Dict[str, str]``: the SDK derives
the Gemini declaration from the annotations, and a property-less object item
tells the model nothing about the fields a card needs.

No ``from __future__ import annotations``: the SDK reads the live annotations.
"""

import json
from pathlib import Path
from typing import Any, Dict, List

from typing_extensions import TypedDict

from ._common import build, chat_only_capabilities

# The dojo's fixed catalog. The page registers it through CopilotKit's `a2ui`
# prop; the surface only has to name it.
CATALOG_ID = "https://a2ui.org/demos/dojo/fixed_catalog.json"

_SCHEMAS_DIR = Path(__file__).parent / "a2ui_fixed_schema_schemas"


def _load_schema(name: str) -> List[Dict[str, Any]]:
    with open(_SCHEMAS_DIR / name, encoding="utf-8") as handle:
        return json.load(handle)


FLIGHT_SURFACE_ID = "flight-search-results"
FLIGHT_SCHEMA = _load_schema("flight_schema.json")

HOTEL_SURFACE_ID = "hotel-search-results"
HOTEL_SCHEMA = _load_schema("hotel_schema.json")


class Flight(TypedDict):
    id: str
    airline: str
    airlineLogo: str
    flightNumber: str
    origin: str
    destination: str
    date: str
    departureTime: str
    arrivalTime: str
    duration: str
    status: str
    statusIcon: str
    price: str


class Hotel(TypedDict):
    id: str
    name: str
    location: str
    rating: float
    price: str


def _envelope(
    surface_id: str, components: List[Dict[str, Any]], data: Dict[str, Any]
) -> Dict[str, Any]:
    """The operations that paint a fixed-layout surface with ``data``."""
    return {
        "a2ui_operations": [
            {
                "version": "v0.9",
                "createSurface": {"surfaceId": surface_id, "catalogId": CATALOG_ID},
            },
            {
                "version": "v0.9",
                "updateComponents": {
                    "surfaceId": surface_id,
                    "components": components,
                },
            },
            {
                "version": "v0.9",
                "updateDataModel": {"surfaceId": surface_id, "path": "/", "value": data},
            },
        ]
    }


def search_flights(flights: List[Flight]) -> Dict[str, Any]:
    """Shows flight search results as rich cards.

    The cards are already on screen when this returns; the JSON result is the
    surface they were drawn from, not something to repeat to the user.

    Args:
      flights: 3-5 realistic flights. airline is a full name such as "United
        Airlines"; airlineLogo is the Google favicon URL for the airline's
        domain, e.g. "https://www.google.com/s2/favicons?domain=united.com&sz=128";
        date is short and near-future, such as "Tue, Mar 18"; duration looks like
        "4h 25m"; status is "On Time" or "Delayed"; statusIcon is
        "https://placehold.co/12/22c55e/22c55e.png" for On Time and
        "https://placehold.co/12/eab308/eab308.png" for Delayed; price looks
        like "$289".
    """
    return _envelope(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA, {"flights": list(flights)})


def search_hotels(hotels: List[Hotel]) -> Dict[str, Any]:
    """Shows hotel search results as rich cards with star ratings.

    The cards are already on screen when this returns; the JSON result is the
    surface they were drawn from, not something to repeat to the user.

    Args:
      hotels: 3-4 realistic hotels. location looks like "Midtown Manhattan,
        NYC"; rating is a number from 0 to 5, such as 4.5; price is per night,
        such as "$350".
    """
    return _envelope(HOTEL_SURFACE_ID, HOTEL_SCHEMA, {"hotels": list(hotels)})


agent = build(
    capabilities=chat_only_capabilities(),
    tools=[search_flights, search_hotels],
    system_instructions=(
        "You are a travel assistant that searches for flights and hotels.\n"
        "- For flights, call search_flights once with 3-5 realistic results.\n"
        "- For hotels, call search_hotels once with 3-4 realistic results.\n"
        "- The tool draws the results as cards. Afterwards, do not repeat or "
        "summarise the data: reply with one short sentence, such as offering "
        "to book one, and stop."
    ),
)
