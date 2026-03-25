"""
Streaming A2UI tools: flight + hotel search with progressive rendering.

These are plain @tools — the streaming behavior comes entirely from the
middleware config (streamingSurfaces in the runtime). The middleware:
  1. Matches the tool name to a registered streaming surface
  2. Emits createSurface + updateComponents on TOOL_CALL_START
  3. Partial-parses the data array as the LLM streams tool args
  4. Emits updateDataModel progressively so cards appear one by one
"""

import os
from typing import Any, List
from typing_extensions import TypedDict

from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, MessagesState
from langgraph.prebuilt import ToolNode


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


@tool
def search_flights_streaming(flights: list[Flight]) -> str:
    """Search for flights and display results with streaming A2UI rendering.

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
    return f"Displayed {len(flights)} flights."


@tool
def search_hotels_streaming(hotels: list[Hotel]) -> str:
    """Search for hotels and display results with streaming A2UI rendering.

    Each hotel must have: id, name (e.g. "The Plaza"),
    location (e.g. "Midtown Manhattan, NYC"),
    rating (float 0-5, e.g. 4.5),
    and price (per night, e.g. "$350").

    Generate 3-4 realistic hotel results.
    """
    return f"Displayed {len(hotels)} hotels."


TOOLS = [search_flights_streaming, search_hotels_streaming]


class AgentState(MessagesState):
    tools: List[Any]


SYSTEM_PROMPT = """You are a helpful travel assistant that can search for flights and hotels.

When the user asks about flights, use the search_flights_streaming tool.
When the user asks about hotels, use the search_hotels_streaming tool.
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
