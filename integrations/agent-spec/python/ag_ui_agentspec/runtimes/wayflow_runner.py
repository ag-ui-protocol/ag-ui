import logging
from typing import Any, Dict

from wayflowcore import Flow as WayflowFlow
from wayflowcore import Agent as WayflowAgent
from wayflowcore.agentspec.tracing import AgentSpecEventListener
from wayflowcore.events.eventlistener import register_event_listeners
from wayflowcore.messagelist import Message, MessageType, ToolRequest, ToolResult

from ag_ui.core import RunAgentInput
from ag_ui_agentspec.agentspec_tracing_exporter import EVENT_QUEUE
from ag_ui_agentspec.message_content import content_to_text, should_skip_role

logger = logging.getLogger("ag_ui_agentspec.tracing")

def prepare_wayflow_agent_input(input_data: RunAgentInput) -> Dict[str, Any]:
    messages = [m.model_dump() for m in input_data.messages]
    wayflow_messages = []
    for m in messages:
        if should_skip_role(m["role"], message_id=m.get("id")):
            continue
        match m["role"]:
            # WayFlow has no developer slot; a developer message is instructions,
            # which is what a system message is to the model.
            case "system" | "developer":
                wm = Message(message_type=MessageType.SYSTEM, content=m["content"])
            case "user":
                wm = Message(
                    message_type=MessageType.USER,
                    content=content_to_text(m["content"], message_id=m.get("id")),
                )
            case "assistant":
                wm = Message(
                    message_type=MessageType.AGENT,
                    # .get: content is optional on an assistant message and is absent
                    # from the dump when unset, not present as None. The system/user/
                    # tool branches keep [] because content is required there, so a
                    # missing key is a real error rather than an empty turn.
                    content=m.get("content"),
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
                        content=content_to_text(m["content"], message_id=m.get("id")),
                        tool_request_id=m["tool_call_id"],
                    ),
                )
            case _:
                raise NotImplementedError(f"Unsupported message: {m}")
        wayflow_messages.append(wm)
    return wayflow_messages


def prepare_wayflow_flow_input(input_data: RunAgentInput) -> Dict[str, Any]:
    # A trailing activity or reasoning message is not the user's input; take the
    # last conversation turn instead.
    last = [
        m for m in input_data.messages if not should_skip_role(m.role, message_id=m.id)
    ][-1]
    return {"user_input": content_to_text(last.content, message_id=last.id)}


async def run_wayflow(agent: Any, input_data: RunAgentInput) -> None:
    current_queue = EVENT_QUEUE.get()

    if isinstance(agent, WayflowAgent):
        agent._add_talk_to_user_tool = False
        agent._update_internal_state()
        agent_input = prepare_wayflow_agent_input(input_data)

        token = EVENT_QUEUE.set(current_queue)
        try:
            with register_event_listeners([AgentSpecEventListener()]):
                conversation = agent.start_conversation(messages=agent_input)
                await conversation.execute_async()
        except Exception as e:
            logger.exception("[AG-UI Agent Spec] Wayflow agent crashed with error: %s", repr(e))
            raise
        finally:
            EVENT_QUEUE.reset(token)

    elif isinstance(agent, WayflowFlow):
        flow_input = prepare_wayflow_flow_input(input_data)
        token = EVENT_QUEUE.set(current_queue)
        try:
            with register_event_listeners([AgentSpecEventListener()]):
                conversation = agent.start_conversation(flow_input)
                await conversation.execute_async()
        except Exception as e:
            logger.exception("[AG-UI Agent Spec] Wayflow flow crashed with error: %s", repr(e))
            raise
        finally:
            EVENT_QUEUE.reset(token)

    else:
        raise NotImplementedError("Unsupported Wayflow component type")
