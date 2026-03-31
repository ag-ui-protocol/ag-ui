"""
Fixed-schema A2UI: flight + hotel search results (no streaming).

Schema is loaded from JSON files. Only the data changes per invocation.
The hotel search demonstrates a custom catalog with a StarRating component.
"""

import os
from pathlib import Path
from typing import Any, List
from typing_extensions import TypedDict

from copilotkit import a2ui
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, MessagesState
from langgraph.prebuilt import ToolNode


# --- Flight search (basic catalog) ---

FLIGHT_SURFACE_ID = "flight-search-results"
FLIGHT_SCHEMA = a2ui.load_schema(
    Path(__file__).parent / "schemas" / "flight_schema.json"
)

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


@tool
def search_flights(flights: list[Flight]) -> str:
    """Search for flights and display the results as rich cards.

    Each flight must have: id, airline (e.g. "United Airlines"),
    airlineLogo (use Google favicon API: https://www.google.com/s2/favicons?domain={airline_domain}&sz=128
    e.g. "https://www.google.com/s2/favicons?domain=united.com&sz=128" for United,
    "https://www.google.com/s2/favicons?domain=delta.com&sz=128" for Delta,
    "https://www.google.com/s2/favicons?domain=aa.com&sz=128" for American,
    "https://www.google.com/s2/favicons?domain=alaskaair.com&sz=128" for Alaska),
    flightNumber, origin, destination,
    date (short readable format like "Tue, Mar 18" — use near-future dates),
    departureTime, arrivalTime,
    duration (e.g. "4h 25m"), status (e.g. "On Time" or "Delayed"),
    statusIcon (colored dot: use "https://placehold.co/12/22c55e/22c55e.png"
    for On Time, "https://placehold.co/12/eab308/eab308.png" for Delayed,
    "https://placehold.co/12/ef4444/ef4444.png" for Cancelled),
    and price (e.g. "$289").
    """
    return a2ui.render(
        operations=[
            a2ui.create_surface(FLIGHT_SURFACE_ID),
            a2ui.update_components(FLIGHT_SURFACE_ID, FLIGHT_SCHEMA),
            a2ui.update_data_model(FLIGHT_SURFACE_ID, {"flights": flights}),
        ],
    )


# --- Hotel search (custom catalog with StarRating) ---

CUSTOM_CATALOG_ID = "https://a2ui.org/demos/dojo/custom_catalog.json"
HOTEL_SURFACE_ID = "hotel-search-results"
HOTEL_SCHEMA = a2ui.load_schema(
    Path(__file__).parent / "schemas" / "hotel_schema.json"
)

class Hotel(TypedDict):
    id: str
    name: str
    location: str
    rating: float
    price: str


@tool
def search_hotels(hotels: list[Hotel]) -> str:
    """Search for hotels and display the results as rich cards with star ratings.

    Each hotel must have: id, name (e.g. "The Plaza"),
    location (e.g. "Midtown Manhattan, NYC"),
    rating (float 0-5, e.g. 4.5),
    and price (per night, e.g. "$350").

    Generate 3-4 realistic hotel results.
    """
    return a2ui.render(
        operations=[
            a2ui.create_surface(HOTEL_SURFACE_ID, catalog_id=CUSTOM_CATALOG_ID),
            a2ui.update_components(HOTEL_SURFACE_ID, HOTEL_SCHEMA),
            a2ui.update_data_model(HOTEL_SURFACE_ID, {"hotels": hotels}),
        ],
    )


TOOLS = [search_flights, search_hotels]


class AgentState(MessagesState):
    tools: List[Any]


SYSTEM_PROMPT = """You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights tool.
When the user asks about hotels, use the search_hotels tool.
IMPORTANT: After calling a tool, do NOT repeat or summarize the data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results" or ask if they'd like to book.

For flights, each needs: id, airline, airlineLogo (Google favicon API), flightNumber, origin, destination,
date, departureTime, arrivalTime, duration, status, statusIcon, and price.

For hotels, each needs: id, name, location, rating (float 0-5), and price (per night).

Generate 3-5 realistic results."""


async def chat_node(state: AgentState, config: RunnableConfig):
    model = ChatOpenAI(model="gpt-4o")
    model = model.bind_tools(TOOLS, parallel_tool_calls=False)

    response = await model.ainvoke([
        SystemMessage(content=SYSTEM_PROMPT),
        *state["messages"],
    ], config)

    return {"messages": [response]}


def route_after_chat(state: AgentState):
    last_message = state["messages"][-1]
    if hasattr(last_message, "tool_calls") and last_message.tool_calls:
        return "tool_node"
    return END


workflow = StateGraph(AgentState)
workflow.add_node("chat_node", chat_node)
workflow.add_node("tool_node", ToolNode(tools=TOOLS))
workflow.set_entry_point("chat_node")
workflow.add_conditional_edges("chat_node", route_after_chat)
workflow.add_edge("tool_node", "chat_node")

is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

if is_fast_api:
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    graph = workflow.compile()
