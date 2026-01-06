import asyncio
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

    def _invoke_with_context(inputs: Dict[str, Any]) -> None:
        token = EVENT_QUEUE.set(current_queue)
        try:
            for _ in agent.stream(inputs, stream_mode="messages", config=config):
                pass
        except Exception as e:
            print(traceback.format_exc())
            raise RuntimeError("LangGraph agent crashed (see printed traceback above):" + repr(e))
        finally:
            EVENT_QUEUE.reset(token)

    await asyncio.to_thread(_invoke_with_context, inputs)


async def run_langgraph_agent_nostream(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    inputs = prepare_langgraph_agent_inputs(input_data)
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})

    current_queue = EVENT_QUEUE.get()

    def _invoke_with_context(inputs: Dict[str, Any]) -> None:
        token = EVENT_QUEUE.set(current_queue)
        try:
            agent.invoke(inputs, config=config)
        finally:
            EVENT_QUEUE.reset(token)

    await asyncio.to_thread(_invoke_with_context, inputs)

