"""
AG-UI FastAPI server for CrewAI.
"""
import copy
import asyncio
from typing import List, Optional
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

from crewai.utilities.events import (
    FlowStartedEvent,
    FlowFinishedEvent,
    MethodExecutionStartedEvent,
    MethodExecutionFinishedEvent,
)
from crewai.flow.flow import Flow
from crewai.utilities.events.base_event_listener import BaseEventListener
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

QUEUES = {}
QUEUES_LOCK = asyncio.Lock()


async def create_queue(flow: object) -> asyncio.Queue:
    """Create a queue for a flow."""
    queue_id = id(flow)
    async with QUEUES_LOCK:
        queue = asyncio.Queue()
        QUEUES[queue_id] = queue
        return queue


def get_queue(flow: object) -> Optional[asyncio.Queue]:
    """Get the queue for a flow."""
    queue_id = id(flow)
    # not using a lock here should be fine
    return QUEUES.get(queue_id)

async def delete_queue(flow: object) -> None:
    """Delete the queue for a flow."""
    queue_id = id(flow)
    async with QUEUES_LOCK:
        if queue_id in QUEUES:
            del QUEUES[queue_id]

GLOBAL_EVENT_LISTENER = None

class FastAPICrewFlowEventListener(BaseEventListener):
    """FastAPI CrewFlow event listener"""

    def setup_listeners(self, crewai_event_bus):
        """Setup listeners for the FastAPI CrewFlow event listener"""
        @crewai_event_bus.on(FlowStartedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            queue = get_queue(source)
            if queue is not None:
                queue.put_nowait(
                    RunStartedEvent(
                        type=EventType.RUN_STARTED,
                         # will be replaced by the correct thread_id/run_id when sending the event
                        thread_id="?",
                        run_id="?",
                    ),
                )
        @crewai_event_bus.on(FlowFinishedEvent)
        def _(source, event):  # pylint: disable=unused-argument
            queue = get_queue(source)
            if queue is not None:
                queue.put_nowait(
                    RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id="?",
                        run_id="?",
                    ),
                )
                queue.put_nowait(None)
        @crewai_event_bus.on(MethodExecutionStartedEvent)
        def _(source, event):
            queue = get_queue(source)
            if queue is not None:
                queue.put_nowait(
                    StepStartedEvent(
                        type=EventType.STEP_STARTED,
                        step_name=event.method_name
                    )
                )
        @crewai_event_bus.on(MethodExecutionFinishedEvent)
        def _(source, event):
            queue = get_queue(source)
            if queue is not None:
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
            queue = get_queue(source)
            if queue is not None:
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
            queue = get_queue(source)
            if queue is not None:
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
            queue = get_queue(source)
            if queue is not None:
                queue.put_nowait(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=event.name,
                        value=event.value
                    )
                )
        @crewai_event_bus.on(BridgedStateSnapshotEvent)
        def _(source, event):
            queue = get_queue(source)
            if queue is not None:
                queue.put_nowait(
                    StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=event.snapshot
                    )
                )

def add_crewai_flow_fastapi_endpoint(app: FastAPI, flow: Flow, path: str = "/"):
    """Adds a CrewAI endpoint to the FastAPI app."""
    global GLOBAL_EVENT_LISTENER # pylint: disable=global-statement

    # Set up the global event listener singleton
    # we are doing this here because calling add_crewai_flow_fastapi_endpoint is a clear indicator
    # that we are not running on CrewAI enterprise
    if GLOBAL_EVENT_LISTENER is None:
        GLOBAL_EVENT_LISTENER = FastAPICrewFlowEventListener()

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
            queue = await create_queue(flow_copy)
            token = flow_context.set(flow_copy)
            try:
                asyncio.create_task(flow_copy.kickoff_async(inputs=inputs))

                while True:
                    item = await queue.get()
                    if item is None:
                        break

                    if item.type == EventType.RUN_STARTED or item.type == EventType.RUN_FINISHED:
                        item.thread_id = input_data.thread_id
                        item.run_id = input_data.run_id

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
                await delete_queue(flow_copy)
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
