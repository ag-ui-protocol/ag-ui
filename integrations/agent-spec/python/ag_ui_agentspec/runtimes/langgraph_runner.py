import asyncio
from typing import Any, Dict
import traceback

from langchain_core.runnables import RunnableConfig
from langgraph.graph.state import CompiledStateGraph

from ag_ui.core import RunAgentInput
import json as _json
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE

import logging
logger = logging.getLogger(__file__)


def prepare_langgraph_agent_inputs(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = input_data.messages

    payload: Dict[str, Any] = {
        # Some prebuilt graphs expect a stable key; use thread_id
        "key": input_data.thread_id,
        "remaining_steps": 20,
        "messages": [],
    }

    if not messages:
        return payload

    # send only last user/tool messages to avoid duplication with MemorySaver checkpointer
    messages_to_return = []
    # last two messages because in the tool_based_generative_ui example, after generating the haiku tool call, the tool result "Haiku generated!" is not sent back immediately
    # but instead the tool result is sent back only when the user sends a new message
    for m in messages[-2:]:
        m_dict = m.model_dump()
        if m_dict["role"] in {"tool", "user"}:
            if m_dict["role"] == "user" and "name" in m_dict:
                del m_dict["name"]
            messages_to_return.append(m_dict)

    if input_data.forwarded_props:
        # Inject forwardedProps to give the agent/LLM visibility into A2UI actions/context
        # Here, we only return a single user message here instead of the last two (tool, user)
        # otherwise there is a bug about getting a tool message without a tool call (if the agent made a server tool call in the prior turn)
        # this bug happens because the MemorySaver checkpointer already caches the tool result
        # and we should not append that same tool result message again
        messages_to_return = [
            {
                "role": "user",
                "content": f"User Action: {_json.dumps(input_data.forwarded_props)}",
            }
        ]
    logger.error(f"{messages_to_return}")
    payload["messages"] = messages_to_return
    return payload


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
            logger.error(traceback.format_exc())
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
