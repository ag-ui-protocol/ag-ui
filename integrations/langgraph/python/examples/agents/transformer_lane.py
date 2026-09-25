"""Platform parity lane: every example graph uses the real AG-UI transformer."""
from ag_ui_langgraph.transformer import agui_transformer
from ag_ui_langgraph import AGUICustomEventBridge
from agents.agentic_chat.agent import graph as agentic_chat
from agents.backend_tool_rendering.agent import graph as backend_tool_rendering
from agents.agentic_generative_ui.agent import graph as agentic_generative_ui
from agents.human_in_the_loop.agent import graph as human_in_the_loop
from agents.predictive_state_updates.agent import graph as predictive_state_updates
from agents.shared_state.agent import graph as shared_state
from agents.tool_based_generative_ui.agent import graph as tool_based_generative_ui
from agents.agentic_chat_reasoning.agent import graph as agentic_chat_reasoning
from agents.agentic_chat_multimodal.agent import graph as agentic_chat_multimodal
from agents.subgraphs.agent import graph as subgraphs
from agents.a2ui_fixed_schema.agent import graph as a2ui_fixed_schema
from agents.a2ui_dynamic_schema.agent import graph as a2ui_dynamic_schema
from agents.deepagents_subagents.agent import graph as deepagents_subagents

# with_config merges existing callbacks and returns a copy. Configure the root
# once; callback inheritance covers its nodes and nested subgraphs.
for graph_name in (
    "agentic_chat", "backend_tool_rendering", "agentic_generative_ui",
    "human_in_the_loop", "predictive_state_updates", "shared_state",
    "tool_based_generative_ui", "agentic_chat_reasoning", "agentic_chat_multimodal",
    "subgraphs", "a2ui_fixed_schema", "a2ui_dynamic_schema", "deepagents_subagents",
):
    graph = globals()[graph_name].with_config(callbacks=[AGUICustomEventBridge()])
    factories = tuple(graph.stream_transformers or ())
    if agui_transformer not in factories:
        graph.stream_transformers = (*factories, agui_transformer)
    globals()[graph_name] = graph
