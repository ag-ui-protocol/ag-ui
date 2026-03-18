"""
Fixed-schema A2UI: flight search results (no streaming).

Schema is loaded from JSON files. Only the data changes per invocation.
Based on the CopilotKit A2UI fixed schema pattern.
"""

import os
from pathlib import Path
from typing import Any, List, TypedDict

from copilotkit import a2ui
from langchain.tools import tool
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, MessagesState
from langgraph.prebuilt import ToolNode


SURFACE_ID = "flight-search-results"
FLIGHT_SCHEMA = a2ui.load_schema(
    Path(__file__).parent / "schemas" / "flight_schema.json"
)
BOOKED_SCHEMA = a2ui.load_schema(
    Path(__file__).parent / "schemas" / "booked_schema.json"
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
            a2ui.surface_update(SURFACE_ID, FLIGHT_SCHEMA),
            a2ui.data_model_update(SURFACE_ID, {"flights": flights}),
            a2ui.begin_rendering(SURFACE_ID, "root"),
        ],
        action_handlers={
            "book_flight": [
                a2ui.surface_update(SURFACE_ID, BOOKED_SCHEMA),
                a2ui.data_model_update(SURFACE_ID, {
                    "title": "Booking Confirmed",
                    "detail": "Your flight has been booked successfully.",
                    "reference": "CK-74921",
                }),
                a2ui.begin_rendering(SURFACE_ID, "root"),
            ],
        },
    )


TOOLS = [search_flights]


class AgentState(MessagesState):
    tools: List[Any]


SYSTEM_PROMPT = """You are a helpful flight search assistant.

When the user asks about flights, use the search_flights tool to display results.
IMPORTANT: After calling search_flights, do NOT repeat or summarize the flight data in your text response. The tool renders a rich UI automatically. Just say something brief like "Here are your results" or ask if they'd like to book.

Each flight needs: id, airline (e.g. "United Airlines"),
airlineLogo (use Google favicon API: https://www.google.com/s2/favicons?domain={airline_domain}&sz=128),
flightNumber, origin, destination,
date (short format like "Tue, Mar 18" — use near-future dates),
departureTime, arrivalTime, duration (e.g. "4h 25m"),
status ("On Time"/"Delayed"/"Cancelled"),
statusIcon (colored dot: "https://placehold.co/12/22c55e/22c55e.png" for On Time,
"https://placehold.co/12/eab308/eab308.png" for Delayed,
"https://placehold.co/12/ef4444/ef4444.png" for Cancelled),
and price (e.g. "$289").

Generate 3-5 realistic flight results."""


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
