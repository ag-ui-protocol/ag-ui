"""
AG-UI FastAPI server for SuperOptiX.
"""
import asyncio
import uuid
from typing import List, Optional, Dict, Any
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse

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

from superoptix.runners.dspy_runner import DSPyRunner

QUEUES = {}
QUEUES_LOCK = asyncio.Lock()


async def create_queue(runner: DSPyRunner) -> asyncio.Queue:
    """Create a queue for a runner."""
    queue_id = id(runner)
    async with QUEUES_LOCK:
        queue = asyncio.Queue()
        QUEUES[queue_id] = queue
        return queue


def get_queue(runner: DSPyRunner) -> Optional[asyncio.Queue]:
    """Get the queue for a runner."""
    queue_id = id(runner)
    return QUEUES.get(queue_id)


async def delete_queue(runner: DSPyRunner) -> None:
    """Delete the queue for a runner."""
    queue_id = id(runner)
    async with QUEUES_LOCK:
        if queue_id in QUEUES:
            del QUEUES[queue_id]


def superoptix_prepare_inputs(
    *,
    state: dict,
    messages: List[Message],
    tools: List[Tool],
) -> Dict[str, Any]:
    """Prepare inputs for SuperOptiX agent."""
    # Convert AG-UI messages to SuperOptiX format
    messages_data = [message.model_dump() for message in messages]
    
    # Remove system message if present
    if len(messages_data) > 0:
        if "role" in messages_data[0] and messages_data[0]["role"] == "system":
            messages_data = messages[1:]
    
    # Convert tools to SuperOptiX format
    tools_data = [tool.model_dump() for tool in tools]
    
    # Prepare state for SuperOptiX
    new_state = {
        **state,
        "messages": messages_data,
        "tools": tools_data
    }
    
    return new_state


def add_superoptix_fastapi_endpoint(
    app: FastAPI, 
    agent_name: str, 
    project_root: Optional[Path] = None,
    path: str = "/"
):
    """Adds a SuperOptiX endpoint to the FastAPI app."""
    
    @app.post(path)
    async def agentic_chat_endpoint(input_data: RunAgentInput, request: Request):
        """SuperOptiX agentic chat endpoint"""
        
        # Initialize SuperOptiX runner
        runner = DSPyRunner(
            agent_name=agent_name,
            project_root=project_root
        )
        
        # Get the accept header from the request
        accept_header = request.headers.get("accept")
        
        # Create an event encoder to properly format SSE events
        encoder = EventEncoder(accept=accept_header)
        
        # Prepare inputs for SuperOptiX
        inputs = superoptix_prepare_inputs(
            state=input_data.state,
            messages=input_data.messages,
            tools=input_data.tools,
        )
        
        # Extract the main query from messages
        query = ""
        if input_data.messages:
            # Get the last user message as the query
            for message in reversed(input_data.messages):
                if message.role == "user":
                    query = message.content or ""
                    break
        
        async def event_generator():
            try:
                # Send run started event
                yield encoder.encode(
                    RunStartedEvent(
                        type=EventType.RUN_STARTED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id
                    )
                )
                
                # Send step started event
                step_id = str(uuid.uuid4())
                yield encoder.encode(
                    StepStartedEvent(
                        type=EventType.STEP_STARTED,
                        step_id=step_id,
                        name="superoptix_agent_execution"
                    )
                )
                
                # Run the SuperOptiX agent
                result = await runner.run(query=query, **inputs)
                
                # Send step finished event
                yield encoder.encode(
                    StepFinishedEvent(
                        type=EventType.STEP_FINISHED,
                        step_id=step_id
                    )
                )
                
                # Send the result as a text message
                message_id = str(uuid.uuid4())
                
                # Start message
                yield encoder.encode({
                    "type": EventType.TEXT_MESSAGE_START,
                    "message_id": message_id,
                    "role": "assistant"
                })
                
                # Send content in chunks
                if isinstance(result, dict):
                    content = result.get("implementation", str(result))
                else:
                    content = str(result)
                
                # Split content into chunks for streaming
                chunk_size = 50
                for i in range(0, len(content), chunk_size):
                    chunk = content[i:i + chunk_size]
                    yield encoder.encode({
                        "type": EventType.TEXT_MESSAGE_CHUNK,
                        "message_id": message_id,
                        "delta": chunk
                    })
                
                # End message
                yield encoder.encode({
                    "type": EventType.TEXT_MESSAGE_END,
                    "message_id": message_id
                })
                
                # Send run finished event
                yield encoder.encode(
                    RunFinishedEvent(
                        type=EventType.RUN_FINISHED,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id
                    )
                )
                
            except Exception as error:
                yield encoder.encode(
                    RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        thread_id=input_data.thread_id,
                        run_id=input_data.run_id,
                        error=str(error)
                    )
                )
        
        return StreamingResponse(
            event_generator(),
            media_type=encoder.get_content_type()
        ) 