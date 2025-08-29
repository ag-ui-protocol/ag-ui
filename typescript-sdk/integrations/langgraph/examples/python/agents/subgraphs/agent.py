"""
A travel agent supervisor demo showcasing multi-agent architecture with subgraphs.
The supervisor coordinates specialized agents: flights finder, hotels finder, and experiences finder.
"""

from typing import Dict, List, Any, Optional, Annotated, Union
from dataclasses import dataclass
import json
import os
from pydantic import BaseModel, Field

# LangGraph imports
from langchain_core.runnables import RunnableConfig
from langgraph.graph import StateGraph, END, START
from langgraph.types import Command, interrupt
from langgraph.graph import MessagesState

# OpenAI imports
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, AIMessage

def create_interrupt(message: str, options: List[Any], recommendation: Any, agent: str):
    return interrupt({
        "message": message,
        "options": options,
        "recommendation": recommendation,
        "agent": agent,
    })

# State schema for travel planning
@dataclass
class Flight:
    airline: str
    departure: str
    arrival: str
    price: str
    duration: str

@dataclass
class Hotel:
    name: str
    location: str
    price_per_night: str
    rating: str

@dataclass
class Experience:
    name: str
    type: str  # "restaurant" or "activity"
    description: str
    location: str

def merge_itinerary(left: Union[dict, None] = None, right: Union[dict, None] = None) -> dict:
    """Custom reducer to merge shopping cart updates."""
    if not left:
        left = {}
    if not right:
        right = {}

    return {**left, **right}

class TravelAgentState(MessagesState):
    """Shared state for the travel agent system"""
    # Travel request details
    origin: str = ""
    destination: str = ""

    # Results from each agent
    flights: List[Flight] = None
    hotels: List[Hotel] = None
    experiences: List[Experience] = None

    itinerary: Annotated[dict, merge_itinerary] = None

    # Tools available to all agents
    tools: List[Any] = None

    # Supervisor routing
    next_agent: Optional[str] = None

# Static data for demonstration
STATIC_FLIGHTS = [
    Flight("KLM", "Amsterdam (AMS)", "San Francisco (SFO)", "$650", "11h 30m"),
    Flight("United", "Amsterdam (AMS)", "San Francisco (SFO)", "$720", "12h 15m")
]

STATIC_HOTELS = [
    Hotel("Hotel Zephyr", "Fisherman's Wharf", "$280/night", "4.2 stars"),
    Hotel("The Ritz-Carlton", "Nob Hill", "$550/night", "4.8 stars"),
    Hotel("Hotel Zoe", "Union Square", "$320/night", "4.4 stars")
]

STATIC_EXPERIENCES = [
    Experience("Pier 39", "activity", "Iconic waterfront destination with shops and sea lions", "Fisherman's Wharf"),
    Experience("Golden Gate Bridge", "activity", "World-famous suspension bridge with stunning views", "Golden Gate"),
    Experience("Swan Oyster Depot", "restaurant", "Historic seafood counter serving fresh oysters", "Polk Street"),
    Experience("Tartine Bakery", "restaurant", "Artisanal bakery famous for bread and pastries", "Mission District")
]

# Flights finder subgraph
async def flights_finder(state: TravelAgentState, config: RunnableConfig):
    """Subgraph that finds flight options"""

    # Simulate flight search with static data
    flights = STATIC_FLIGHTS

    selected_flight = state.get('itinerary', {}).get('flight', None)
    if not selected_flight:
        selected_flight = create_interrupt(
            message=f"""
        Found {len(flights)} flight options from {state.get('origin', 'Amsterdam')} to {state.get('destination', 'San Francisco')}.
        I recommend choosing the flight by {flights[0].airline} since it's known to be on time and cheaper.
        """,
            options=flights,
            recommendation=flights[0],
            agent="flights"
        )

    if isinstance(selected_flight, str):
        selected_flight = json.loads(selected_flight)
    return Command(
        goto=END,
        update={
            "flights": flights,
            "itinerary": {
                "flight": selected_flight
            },
            "messages": state["messages"] + [{
                "role": "assistant",
                "content": f"Flights Agent: Great. I'll book you the {selected_flight["airline"]} flight from {selected_flight["departure"]} to {selected_flight["arrival"]}."
            }]
        }
    )

# Hotels finder subgraph
async def hotels_finder(state: TravelAgentState, config: RunnableConfig):
    """Subgraph that finds hotel options"""

    # Simulate hotel search with static data
    hotels = STATIC_HOTELS
    selected_hotel = state.get('itinerary', {}).get('hotel', None)
    if not selected_hotel:
        selected_hotel = create_interrupt(
            message=f"""
        Found {len(hotels)} accommodation options in {state.get('destination', 'San Francisco')}.
        I recommend choosing the {hotels[2].name} since it strikes the balance between rating, price, and location.
        """,
            options=hotels,
            recommendation=hotels[2],
            agent="hotels"
        )

    if isinstance(selected_hotel, str):
        selected_hotel = json.loads(selected_hotel)
    return Command(
            goto=END,
            update={
                "hotels": hotels,
                "itinerary": {
                    "hotel": selected_hotel
                },
                "messages": state["messages"] + [{
                    "role": "assistant",
                    "content": f"Hotels Agent: Excellent choice! You'll like {selected_hotel["name"]}."
                }]
            }
        )

# Experiences finder subgraph
async def experiences_finder(state: TravelAgentState, config: RunnableConfig):
    """Subgraph that finds restaurant and activity recommendations"""

    # Filter experiences (2 restaurants, 2 activities)
    restaurants = [exp for exp in STATIC_EXPERIENCES if exp.type == "restaurant"][:2]
    activities = [exp for exp in STATIC_EXPERIENCES if exp.type == "activity"][:2]
    experiences = restaurants + activities

    model = ChatOpenAI(model="gpt-4o")

    if config is None:
        config = RunnableConfig(recursion_limit=25)

    itinerary = state.get("itinerary", {})

    system_prompt = f"""
    You are the experiences agent. Your job is to find restaurants and activities for the user.
    You already went ahead and found a bunch of experiences. All you have to do now, is to let the user know of your findings.
    
    Current status:
    - Origin: {state.get('origin', 'Amsterdam')}
    - Destination: {state.get('destination', 'San Francisco')}
    - Flight chosen: {itinerary.get("hotel", None)}
    - Hotel chosen: {itinerary.get("hotel", None)}
    - activities found: {activities}
    - restaurants found: {restaurants}
    """

    # Get supervisor decision
    response = await model.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)

    return Command(
        goto=END,
        update={
            "experiences": experiences,
            "messages": state["messages"] + [response]
        }
    )

class SupervisorResponseFormatter(BaseModel):
    """Always use this tool to structure your response to the user."""
    answer: str = Field(description="The answer to the user")
    next_agent: str | None = Field(description="The agent to go to. Not required if you do not want to route to another agent.")

# Supervisor agent
async def supervisor_agent(state: TravelAgentState, config: RunnableConfig):
    """Main supervisor that coordinates all subgraphs"""

    itinerary = state.get("itinerary", {})

    # Check what's already completed
    has_flights = itinerary.get("flight", None) is not None
    has_hotels = itinerary.get("hotel", None) is not None
    has_experiences = state.get("experiences", None) is not None

    system_prompt = f"""
    You are a travel planning supervisor. Your job is to coordinate specialized agents to help plan a trip.
    
    Current status:
    - Origin: {state.get('origin', 'Amsterdam')}
    - Destination: {state.get('destination', 'San Francisco')}
    - Flights found: {has_flights}
    - Hotels found: {has_hotels}
    - Experiences found: {has_experiences}
    - Itinerary (Things that the user has already confirmed selection on): {json.dumps(itinerary, indent=2)}
    
    Available agents:
    - flights_agent: Finds flight options
    - hotels_agent: Finds hotel options  
    - experiences_agent: Finds restaurant and activity recommendations
    - {END}: Mark task as complete when all information is gathered
    
    You must route to the appropriate agent based on what's missing. Once all agents have completed their tasks, route to 'complete'.
    """

    # Define the model
    model = ChatOpenAI(model="gpt-4o")

    if config is None:
        config = RunnableConfig(recursion_limit=25)

    # Bind the routing tool
    model_with_tools = model.bind_tools(
        [SupervisorResponseFormatter],
        parallel_tool_calls=False,
    )

    # Get supervisor decision
    response = await model_with_tools.ainvoke([
        SystemMessage(content=system_prompt),
        *state["messages"],
    ], config)

    messages = state["messages"] + [response]

    # Handle tool calls for routing
    if hasattr(response, "tool_calls") and response.tool_calls:
        tool_call = response.tool_calls[0]

        if isinstance(tool_call, dict):
            tool_call_args = tool_call["args"]
        else:
            tool_call_args = tool_call.args

        next_agent = tool_call_args["next_agent"]

        # Add tool response
        tool_response = {
            "role": "tool",
            "content": f"Routing to {next_agent} and providing the answer",
            "tool_call_id": tool_call.id if hasattr(tool_call, 'id') else tool_call["id"]
        }

        messages = messages + [tool_response, AIMessage(content=tool_call_args["answer"])]

        if next_agent is not None:
            return Command(goto=next_agent)

    # Fallback if no tool call
    return Command(
        goto=END,
        update={"messages": messages}
    )

# Create subgraphs
flights_graph = StateGraph(TravelAgentState)
flights_graph.add_node("flights_agent_chat_node", flights_finder)
flights_graph.set_entry_point("flights_agent_chat_node")
flights_graph.add_edge(START, "flights_agent_chat_node")
flights_graph.add_edge("flights_agent_chat_node", END)
flights_subgraph = flights_graph.compile()

hotels_graph = StateGraph(TravelAgentState)
hotels_graph.add_node("hotels_agent_chat_node", hotels_finder)
hotels_graph.set_entry_point("hotels_agent_chat_node")
hotels_graph.add_edge(START, "hotels_agent_chat_node")
hotels_graph.add_edge("hotels_agent_chat_node", END)
hotels_subgraph = hotels_graph.compile()

experiences_graph = StateGraph(TravelAgentState)
experiences_graph.add_node("experiences_agent_chat_node", experiences_finder)
experiences_graph.set_entry_point("experiences_agent_chat_node")
experiences_graph.add_edge(START, "experiences_agent_chat_node")
experiences_graph.add_edge("experiences_agent_chat_node", END)
experiences_subgraph = experiences_graph.compile()

# Main supervisor workflow
workflow = StateGraph(TravelAgentState)

# Add supervisor and subgraphs as nodes
workflow.add_node("supervisor", supervisor_agent)
workflow.add_node("flights_agent", flights_subgraph)
workflow.add_node("hotels_agent", hotels_subgraph)
workflow.add_node("experiences_agent", experiences_subgraph)

# Set entry point
workflow.set_entry_point("supervisor")
workflow.add_edge(START, "supervisor")

# Add edges back to supervisor after each subgraph
workflow.add_edge("flights_agent", "supervisor")
workflow.add_edge("hotels_agent", "supervisor")
workflow.add_edge("experiences_agent", "supervisor")

# Conditionally use a checkpointer based on the environment
# Check for multiple indicators that we're running in LangGraph dev/API mode
is_fast_api = os.environ.get("LANGGRAPH_FAST_API", "false").lower() == "true"

# Compile the graph
if is_fast_api:
    # For CopilotKit and other contexts, use MemorySaver
    from langgraph.checkpoint.memory import MemorySaver
    memory = MemorySaver()
    graph = workflow.compile(checkpointer=memory)
else:
    # When running in LangGraph API/dev, don't use a custom checkpointer
    graph = workflow.compile()
