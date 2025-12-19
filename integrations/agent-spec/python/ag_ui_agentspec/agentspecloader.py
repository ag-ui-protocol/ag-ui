import json
from typing import Any, Dict, Literal, Optional, TYPE_CHECKING, overload

if TYPE_CHECKING:
    # Replace these with the actual exported types
    from langgraph.graph.state import CompiledStateGraph
    from wayflowcore.conversationalcomponent import ConversationalComponent as WayflowComponent

@overload
def load_agent_spec(
    runtime: Literal["langgraph"],
    agent_spec_json: str,
    tool_registry: Optional[Dict[str, Any]] = None,
) -> "CompiledStateGraph[Any, Any, Any]": ...
@overload
def load_agent_spec(
    runtime: Literal["wayflow"],
    agent_spec_json: str,
    tool_registry: Optional[Dict[str, Any]] = None,
) -> "WayflowComponent": ...

def load_agent_spec(
    runtime: Literal["langgraph", "wayflow"],
    agent_spec_json: str,
    tool_registry: Optional[Dict[str, Any]] = None
) -> object:
    match runtime:
        case "langgraph":
            from pyagentspec.adapters.langgraph import AgentSpecLoader
            from langgraph.checkpoint.memory import MemorySaver
            
            return AgentSpecLoader(tool_registry=tool_registry, checkpointer=MemorySaver()).load_json(agent_spec_json)
        case "wayflow":
            from wayflowcore.agentspec import AgentSpecLoader

            return AgentSpecLoader(tool_registry=tool_registry).load_json(agent_spec_json)
        case _:
            raise ValueError(f"Unsupported runtime: {runtime}")
