

"""AWS Strands Agent implementation for AG-UI.

Simple adapter following the Agno pattern.
"""
import logging
import json
import uuid
import asyncio
from typing import AsyncIterator, Any
from strands import Agent as StrandsAgentCore

logger = logging.getLogger(__name__)
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    MessagesSnapshotEvent,
    StateSnapshotEvent,
    CustomEvent,
    AssistantMessage,
    ToolMessage,
    ToolCall,
)
from .config import (
    StrandsAgentConfig,
    ToolCallContext,
    ToolResultContext,
    maybe_await,
    normalize_predict_state,
)


class StrandsAgent:
    """AWS Strands Agent wrapper for AG-UI integration."""
    
    def __init__(
        self,
        agent: StrandsAgentCore,
        name: str,
        description: str = "",
        config: "StrandsAgentConfig | None" = None,
    ):
        self.strands_agent = agent
        self.name = name
        self.description = description
        self.config = config or StrandsAgentConfig()
    
    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Strands agent and yield AG-UI events."""
        
        # Start run
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id
        )

        try:
            # Emit state snapshot if provided
            if hasattr(input_data, 'state') and input_data.state is not None:
                # Filter out messages from state to avoid "Unknown message role" errors
                # The frontend manages messages separately and doesn't recognize "tool" role
                state_snapshot = {k: v for k, v in input_data.state.items() if k != 'messages'}
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT,
                    snapshot=state_snapshot
                )
            
            # Extract frontend tool names from input_data.tools
            frontend_tool_names = set()
            if input_data.tools:
                for tool_def in input_data.tools:
                    tool_name = tool_def.get("name") if isinstance(tool_def, dict) else getattr(tool_def, "name", None)
                    if tool_name:
                        frontend_tool_names.add(tool_name)
            
            # Check if the last message is a tool result - if so, don't emit tool events again
            has_pending_tool_result = False
            if input_data.messages:
                last_msg = input_data.messages[-1]
                if last_msg.role == "tool":
                    has_pending_tool_result = True
                    logger.debug(f"Has pending tool result detected: tool_call_id={getattr(last_msg, 'tool_call_id', 'unknown')}, thread_id={input_data.thread_id}")
            
            # Get the latest user message
            user_message = "Hello"
            if input_data.messages:
                for msg in reversed(input_data.messages):
                    if msg.role == "user" and msg.content:
                        user_message = msg.content
                        break
            
            # Optionally allow configuration to adjust the outgoing user message
            if self.config.state_context_builder:
                try:
                    user_message = self.config.state_context_builder(input_data, user_message)
                except Exception:
                    # If the builder fails, keep the original message
                    pass
            
            # Generate unique message ID
            message_id = str(uuid.uuid4())
            message_started = False
            tool_calls_seen = {}
            stop_text_streaming = False
            halt_event_stream = False
            
            logger.debug(f"Starting agent run: thread_id={input_data.thread_id}, run_id={input_data.run_id}, has_pending_tool_result={has_pending_tool_result}, message_count={len(input_data.messages)}")
            
            # Stream from Strands agent
            agent_stream = self.strands_agent.stream_async(user_message)
            
            async for event in agent_stream:
                logger.debug(f"Received event: {event}")
                if halt_event_stream:
                    logger.debug(f"Breaking event stream: halt_event_stream flag set to True (thread_id={input_data.thread_id})")
                    break

                # Skip lifecycle events
                if event.get("init_event_loop") or event.get("start_event_loop"):
                    continue
                if event.get("complete") or event.get("force_stop"):
                    logger.debug(f"Breaking event stream: received complete or force_stop event (thread_id={input_data.thread_id}, complete={event.get('complete')}, force_stop={event.get('force_stop')})")
                    break
                
                # Handle text streaming
                elif "data" in event and event["data"]:
                    if stop_text_streaming:
                        continue
                    
                    if not message_started:
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant"
                        )
                        message_started = True
                    
                    text_chunk = str(event["data"])
                    yield TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=message_id,
                        delta=text_chunk
                    )
                
                # Handle tool results from Strands for backend tool rendering
                elif "message" in event and event["message"].get("role") == "user":
                    message_content = event["message"].get("content", [])
                    if not message_content or not isinstance(message_content, list):
                        continue

                    for item in message_content:
                        if not isinstance(item, dict) or "toolResult" not in item:
                            continue

                        tool_result = item["toolResult"]
                        result_tool_id = tool_result.get("toolUseId")
                        result_content = tool_result.get("content", [])

                        result_data = None
                        if result_content and isinstance(result_content, list):
                            for content_item in result_content:
                                if isinstance(content_item, dict) and "text" in content_item:
                                    text_content = content_item["text"]
                                    try:
                                        result_data = json.loads(text_content)
                                    except json.JSONDecodeError:
                                        try:
                                            json_text = text_content.replace("'", '"')
                                            result_data = json.loads(json_text)
                                        except Exception:
                                            result_data = text_content

                        if not result_tool_id or result_data is None:
                            continue

                        call_info = tool_calls_seen.get(result_tool_id, {})
                        tool_name = call_info.get("name")
                        tool_args = call_info.get("args")
                        tool_input = call_info.get("input")
                        behavior = self.config.tool_behaviors.get(tool_name) if tool_name else None
                        
                        logger.debug(f"Processing tool result: tool_name={tool_name}, result_tool_id={result_tool_id}, has_pending_tool_result={has_pending_tool_result}, thread_id={input_data.thread_id}")

                        if not has_pending_tool_result and not (behavior and behavior.skip_messages_snapshot):
                            assistant_msg = AssistantMessage(
                                id=str(uuid.uuid4()),
                                role="assistant",
                                tool_calls=[
                                    ToolCall(
                                        id=result_tool_id,
                                        type="function",
                                        function={
                                            "name": tool_name or "default_tool",
                                            "arguments": tool_args or "{}",
                                        },
                                    )
                                ],
                            )

                            content_str = json.dumps(result_data) if isinstance(result_data, dict) else str(result_data)
                            tool_msg = ToolMessage(
                                id=str(uuid.uuid4()),
                                role="tool",
                                content=content_str,
                                tool_call_id=result_tool_id,
                            )

                            all_messages = list(input_data.messages) + [assistant_msg, tool_msg]
                            yield MessagesSnapshotEvent(
                                type=EventType.MESSAGES_SNAPSHOT,
                                messages=all_messages
                            )

                        result_context = ToolResultContext(
                            input_data=input_data,
                            tool_name=tool_name or "",
                            tool_use_id=result_tool_id,
                            tool_input=tool_input,
                            args_str=tool_args or "{}",
                            result_data=result_data,
                            message_id=message_id,
                        )

                        if behavior and behavior.state_from_result:
                            try:
                                snapshot = await maybe_await(behavior.state_from_result(result_context))
                                if snapshot:
                                    yield StateSnapshotEvent(
                                        type=EventType.STATE_SNAPSHOT,
                                        snapshot=snapshot
                                    )
                            except Exception:
                                pass

                        if behavior and behavior.custom_result_handler:
                            try:
                                async for custom_event in behavior.custom_result_handler(result_context):
                                    if custom_event is not None:
                                        yield custom_event
                            except Exception:
                                pass

                        if behavior and behavior.stop_streaming_after_result:
                            stop_text_streaming = True
                            if message_started:
                                yield TextMessageEndEvent(
                                    type=EventType.TEXT_MESSAGE_END,
                                    message_id=message_id
                                )
                                message_started = False
                            halt_event_stream = True
                            logger.debug(f"Breaking event stream: stop_streaming_after_result behavior triggered (thread_id={input_data.thread_id}, tool_name={tool_name})")
                            break
                
                # Handle tool calls
                elif "current_tool_use" in event and event["current_tool_use"]:
                    tool_use = event["current_tool_use"]
                    tool_name = tool_use.get("name")
                    strands_tool_id = tool_use.get("toolUseId")
                    
                    # Generate unique ID for frontend tools (to avoid ID conflicts across requests)
                    # Use Strands' ID for backend tools (so result lookup works)
                    is_frontend_tool = tool_name in frontend_tool_names
                    if is_frontend_tool:
                        tool_use_id = str(uuid.uuid4())
                    else:
                        tool_use_id = strands_tool_id or str(uuid.uuid4())
                    
                    logger.debug(f"Tool call event received: tool_name={tool_name}, tool_use_id={tool_use_id}, strands_id={strands_tool_id}, is_frontend={is_frontend_tool}, already_seen={tool_use_id in tool_calls_seen}, thread_id={input_data.thread_id}")

                    if tool_name and tool_use_id not in tool_calls_seen:
                        tool_input = tool_use.get("input", {})
                        args_str = json.dumps(tool_input) if isinstance(tool_input, dict) else str(tool_input)
                        tool_calls_seen[tool_use_id] = {
                            "name": tool_name,
                            "args": args_str,
                            "input": tool_input,
                        }

                        is_frontend_tool = tool_name in frontend_tool_names
                        behavior = self.config.tool_behaviors.get(tool_name)
                        
                        logger.debug(f"Processing tool call: tool_name={tool_name}, tool_use_id={tool_use_id}, is_frontend_tool={is_frontend_tool}, has_pending_tool_result={has_pending_tool_result}, tool_calls_seen_count={len(tool_calls_seen)}, thread_id={input_data.thread_id}")
                        call_context = ToolCallContext(
                            input_data=input_data,
                            tool_name=tool_name,
                            tool_use_id=tool_use_id,
                            tool_input=tool_input,
                            args_str=args_str,
                        )

                        if behavior and behavior.state_from_args:
                            try:
                                snapshot = await maybe_await(behavior.state_from_args(call_context))
                                if snapshot:
                                    yield StateSnapshotEvent(
                                        type=EventType.STATE_SNAPSHOT,
                                        snapshot=snapshot
                                    )
                            except Exception:
                                pass

                        if behavior:
                            predict_state_payload = [
                                mapping.to_payload() for mapping in normalize_predict_state(behavior.predict_state)
                            ]
                            if predict_state_payload:
                                yield CustomEvent(
                                    type=EventType.CUSTOM,
                                    name="PredictState",
                                    value=predict_state_payload,
                                )
                        if  has_pending_tool_result:

                            logger.debug(f"Skipping tool call START event due to has_pending_tool_result for {tool_name} (tool_use_id={tool_use_id}, thread_id={input_data.thread_id})")

                        if not has_pending_tool_result:
                            logger.debug(f"Emitting tool call events for {tool_name} (tool_use_id={tool_use_id}, thread_id={input_data.thread_id})")
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_use_id,
                                tool_call_name=tool_name,
                                parent_message_id=message_id
                            )

                            if behavior and behavior.args_streamer:
                                try:
                                    async for chunk in behavior.args_streamer(call_context):
                                        if chunk is None:
                                            continue
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=str(chunk)
                                        )
                                except Exception:
                                    yield ToolCallArgsEvent(
                                        type=EventType.TOOL_CALL_ARGS,
                                        tool_call_id=tool_use_id,
                                        delta=args_str
                                    )
                            else:
                                yield ToolCallArgsEvent(
                                    type=EventType.TOOL_CALL_ARGS,
                                    tool_call_id=tool_use_id,
                                    delta=args_str
                                )

                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_use_id
                            )

                            if is_frontend_tool and not (behavior and behavior.continue_after_frontend_call):
                                logger.debug(f"Breaking event stream: frontend tool call completed (thread_id={input_data.thread_id}, tool_name={tool_name}, tool_call_id={tool_use_id}, has_behavior={behavior is not None}, continue_after_frontend_call={behavior.continue_after_frontend_call if behavior else None})")
                                break
            
            # End message if started
            if message_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END,
                    message_id=message_id
                )
            
            # Always finish the run - frontend handles keeping action executing
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id                    
            )
            
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
                code="STRANDS_ERROR"
            )
