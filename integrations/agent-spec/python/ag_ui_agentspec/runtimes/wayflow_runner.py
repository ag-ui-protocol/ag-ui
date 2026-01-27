import asyncio
from typing import Any, Dict

from wayflowcore import Flow as WayflowFlow
from wayflowcore import Agent as WayflowAgent
from wayflowcore.agentspec.tracing import AgentSpecEventListener
from wayflowcore.events.eventlistener import register_event_listeners
from wayflowcore.messagelist import Message, MessageType, ToolRequest, ToolResult

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE

def prepare_wayflow_agent_input(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = [m.model_dump() for m in input_data.messages]
    wayflow_messages = []
    for m in messages:
        match m["role"]:
            case "system":
                wm = Message(message_type=MessageType.SYSTEM, content=m["content"])
            case "user":
                wm = Message(message_type=MessageType.USER, content=m["content"])
            case "assistant":
                wm = Message(
                    message_type=MessageType.AGENT,
                    content=m["content"],
                    tool_requests=[
                        ToolRequest(
                            name=tc["function"]["name"],
                            args=tc["function"]["arguments"],
                            tool_request_id=tc["id"],
                        )
                        for tc in (m.get("tool_calls") or [])
                    ],
                )
            case "tool":
                wm = Message(
                    message_type=MessageType.TOOL_RESULT,
                    tool_result=ToolResult(
                        content=m["content"], tool_request_id=m["tool_call_id"]
                    ),
                )
            case _:
                raise NotImplementedError(f"Unsupported message: {m}")
        wayflow_messages.append(wm)
    return wayflow_messages


def prepare_wayflow_flow_input(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = input_data.messages
    return {"user_input": messages[-1].content}


async def run_wayflow(agent: Any, input_data: RunAgentInput) -> None:
    current_queue = EVENT_QUEUE.get()

    if isinstance(agent, WayflowAgent):
        agent._add_talk_to_user_tool = False
        agent._update_internal_state()
        agent_input = prepare_wayflow_agent_input(input_data)

        def _invoke_with_context(fi):
            token = EVENT_QUEUE.set(current_queue)
            try:
                with register_event_listeners([AgentSpecEventListener()]):
                    conversation = agent.start_conversation(messages=fi)
                    conversation.execute()
            finally:
                EVENT_QUEUE.reset(token)

        await asyncio.to_thread(_invoke_with_context, agent_input)

    elif isinstance(agent, WayflowFlow):
        flow_input = prepare_wayflow_flow_input(input_data)

        def _invoke_with_context(fi):
            token = EVENT_QUEUE.set(current_queue)
            try:
                with register_event_listeners([AgentSpecEventListener()]):
                    conversation = agent.start_conversation(fi)
                    _ = conversation.execute()
            finally:
                EVENT_QUEUE.reset(token)

        await asyncio.to_thread(_invoke_with_context, flow_input)

    else:
        raise NotImplementedError("Unsupported Wayflow component type")

