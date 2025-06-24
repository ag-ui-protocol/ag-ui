"""
AG-UI FastAPI server for CrewAI.
"""
import copy
import asyncio
from typing import List
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from crewai.utilities.events import (
    crewai_event_bus,
    FlowStartedEvent,
    FlowFinishedEvent,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent,
)
from crewai.flow.flow import Flow
from crewai import Crew

from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    Message,
    Tool
)
from ag_ui.core.events import (
  TextMessageChunkEvent,
  ToolCallChunkEvent,
  StepStartedEvent,
  StepFinishedEvent,
  MessagesSnapshotEvent,
  StateSnapshotEvent,
  CustomEvent,
)
from ag_ui.encoder import EventEncoder

from .events import (
  BridgedTextMessageChunkEvent,
  BridgedToolCallChunkEvent,
  BridgedCustomEvent,
  BridgedStateSnapshotEvent
)
from .context import flow_context
from .sdk import litellm_messages_to_ag_ui_messages
from .crews import ChatWithCrewFlow


def add_crewai_flow_fastapi_endpoint(app: FastAPI, flow: Flow, path: str = "/"):
    """Adds a CrewAI endpoint to the FastAPI app."""


    @app.post(path)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """Agentic chat endpoint"""

        flow_copy = copy.deepcopy(flow)

        # Get the accept header from the request
        accept_header = request.headers.get("accept")

        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)

        inputs = crewai_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
        )

        async def event_generator():
            queue = asyncio.Queue()
            token = flow_context.set(flow_copy)
            try:
                with crewai_event_bus.scoped_handlers():

                    @crewai_event_bus.on(FlowStartedEvent)
                    def _(source, event):  # pylint: disable=unused-argument
                        if source == flow_copy:
                            queue.put_nowait(
                                RunStartedEvent(
                                    type=EventType.RUN_STARTED,
                                    thread_id=input_data.thread_id,
                                    run_id=input_data.run_id,
                                ),
                            )

                    @crewai_event_bus.on(FlowFinishedEvent)
                    def _(source, event):  # pylint: disable=unused-argument
                        if source == flow_copy:
                            queue.put_nowait(
                                RunFinishedEvent(
                                    type=EventType.RUN_FINISHED,
                                    thread_id=input_data.thread_id,
                                    run_id=input_data.run_id,
                                ),
                            )
                            queue.put_nowait(None)
                    
                    @crewai_event_bus.on(MethodExecutionStartedEvent)
                    def _(source, event):
                        if source == flow_copy:
                            queue.put_nowait(
                                StepStartedEvent(
                                    type=EventType.STEP_STARTED,
                                    step_name=event.method_name
                                )
                            )
                    
                    @crewai_event_bus.on(MethodExecutionFinishedEvent)
                    def _(source, event):
                        if source == flow_copy:
                            messages = litellm_messages_to_ag_ui_messages(source.state.messages)

                            queue.put_nowait(
                                MessagesSnapshotEvent(
                                    type=EventType.MESSAGES_SNAPSHOT,
                                    messages=messages
                                )
                            )
                            queue.put_nowait(
                                StateSnapshotEvent(
                                    type=EventType.STATE_SNAPSHOT,
                                    snapshot=source.state
                                )
                            )
                            queue.put_nowait(
                                StepFinishedEvent(
                                    type=EventType.STEP_FINISHED,
                                    step_name=event.method_name
                                )
                            )

                    @crewai_event_bus.on(BridgedTextMessageChunkEvent)
                    def _(source, event):
                        if source == flow_copy:
                            queue.put_nowait(
                                TextMessageChunkEvent(
                                    type=EventType.TEXT_MESSAGE_CHUNK,
                                    message_id=event.message_id,
                                    role=event.role,
                                    delta=event.delta,
                                )
                            )

                    @crewai_event_bus.on(BridgedToolCallChunkEvent)
                    def _(source, event):
                        if source == flow_copy:
                            queue.put_nowait(
                                ToolCallChunkEvent(
                                    type=EventType.TOOL_CALL_CHUNK,
                                    tool_call_id=event.tool_call_id,
                                    tool_call_name=event.tool_call_name,
                                    delta=event.delta,
                                )
                            )

                    @crewai_event_bus.on(BridgedCustomEvent)
                    def _(source, event):
                        if source == flow_copy:
                            queue.put_nowait(
                                CustomEvent(
                                    type=EventType.CUSTOM,
                                    name=event.name,
                                    value=event.value
                                )
                            )

                    @crewai_event_bus.on(BridgedStateSnapshotEvent)
                    def _(source, event):
                        if source == flow_copy:
                            queue.put_nowait(
                                StateSnapshotEvent(
                                    type=EventType.STATE_SNAPSHOT,
                                    snapshot=event.snapshot
                                )
                            )

                    asyncio.create_task(flow_copy.kickoff_async(inputs=inputs))

                    while True:
                        item = await queue.get()
                        if item is None:
                            break
                        yield encoder.encode(item)

            except Exception as e:  # pylint: disable=broad-exception-caught
                yield encoder.encode(
                    RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                        error=str(e),
                    )
                )
            finally:
                flow_context.reset(token)

        return StreamingResponse(event_generator(), media_type=encoder.get_content_type())

def add_crewai_crew_fastapi_endpoint(app: FastAPI, crew: Crew, path: str = "/"):
    """Adds a CrewAI crew endpoint to the FastAPI app."""
    add_crewai_flow_fastapi_endpoint(app, ChatWithCrewFlow(crew=crew), path)


def crewai_prepare_inputs(  # pylint: disable=unused-argument, too-many-arguments
    *,
    state: dict,
    messages: List[Message],
    tools: List[Tool],
):
    """Default merge state for CrewAI"""
    messages = [message.model_dump() for message in messages]

    if len(messages) > 0:
        if "role" in messages[0] and messages[0]["role"] == "system":
            messages = messages[1:]

    actions = [{
        "type": "function",
        "function": {
            **tool.model_dump(),
        }
    } for tool in tools]

    new_state = {
        **state,
        "messages": messages,
        "copilotkit": {
            "actions": actions
        }
    }

    return new_state
