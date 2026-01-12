# Copyright © 2025 Oracle and/or its affiliates.
#
# This software is under the Apache License 2.0
# (LICENSE-APACHE or http://www.apache.org/licenses/LICENSE-2.0) or Universal Permissive License
# (UPL) 1.0 (LICENSE-UPL or https://oss.oracle.com/licenses/upl), at your option.

from typing import Any, Dict
import traceback

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE


def prepare_langgraph_agent_inputs(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = input_data.messages
    if not messages:
        return {"messages": []}
    # send only last user/tool messages to avoid duplication with MemorySaver
    messages_to_return = []
    for m in messages[-2:]:
        m_dict = m.model_dump()
        if m_dict["role"] in {"tool", "user"}:
            if m_dict["role"] == "user" and "name" in m_dict:
                del m_dict["name"]
            messages_to_return.append(m_dict)
    return {"messages": messages_to_return}


async def run_langgraph_agent(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    inputs = prepare_langgraph_agent_inputs(input_data)
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})

    current_queue = EVENT_QUEUE.get()

    token = EVENT_QUEUE.set(current_queue)
    try:
        async for _ in agent.astream(inputs, stream_mode="messages", config=config):
            pass
    except Exception as e:
        raise RuntimeError(f"LangGraph agent crashed with error: {repr(e)}\n\nTraceback: {traceback.format_exc()}")
    finally:
        EVENT_QUEUE.reset(token)


async def run_langgraph_agent_nostream(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    inputs = prepare_langgraph_agent_inputs(input_data)
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})

    current_queue = EVENT_QUEUE.get()

    token = EVENT_QUEUE.set(current_queue)
    try:
        await agent.ainvoke(inputs, config=config)
    finally:
        EVENT_QUEUE.reset(token)
