from typing import Any, Dict
import traceback

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE


def filter_only_new_messages(agent, thread_id: str, input_messages: list[dict]) -> list[dict]:
    config = RunnableConfig({"configurable": {"thread_id": thread_id}})
    snap = agent.get_state(config)
    existing = snap.values.get("messages", []) or []

    # existing entries are usually LangChain message objects; get their ids if present
    existing_ids = set()
    for m in existing:
        mid = getattr(m, "id", None)
        if mid:
            existing_ids.add(mid)

    # input_messages are your dicts from the client (with "id")
    return [m for m in input_messages if m.get("id") not in existing_ids]


def prepare_langgraph_agent_inputs(agent, input_data: RunAgentInput) -> Dict[str, Any]:
    messages = input_data.messages
    if not messages:
        return {"messages": []}
    # send only last user/tool messages to avoid duplication with MemorySaver
    messages_to_return = []
    for m in messages:
        m_dict = m.model_dump()
        if m_dict["role"] in {"user", "assistant"} and "name" in m_dict:
            del m_dict["name"]
        if m_dict["role"] == "tool" and "error" in m_dict:
            del m_dict["error"]
        if m_dict["role"] == "assistant" and m_dict["content"] is None:
            m_dict["content"] = ""
        messages_to_return.append(m_dict)
    messages_to_return = filter_only_new_messages(agent, input_data.thread_id, messages_to_return)
    return {"messages": messages_to_return}


async def run_langgraph_agent(agent: CompiledStateGraph, input_data: RunAgentInput) -> None:
    inputs = prepare_langgraph_agent_inputs(agent, input_data)
    config = RunnableConfig({"configurable": {"thread_id": input_data.thread_id}})

    current_queue = EVENT_QUEUE.get()

    token = EVENT_QUEUE.set(current_queue)
    try:
        async for _ in agent.astream(inputs, stream_mode="messages", config=config):
            pass
    except Exception as e:
        print(f"{repr(e)}{traceback.format_exc()}")
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
