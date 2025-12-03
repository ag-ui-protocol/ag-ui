"""AWS Strands Agent implementation for AG-UI.

Simple adapter following the Agno pattern.
"""

import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List

from strands import Agent as StrandsAgentCore

logger = logging.getLogger(__name__)
from ag_ui.core import (
    AssistantMessage,
    CustomEvent,
    EventType,
    MessagesSnapshotEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCall,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    ToolMessage,
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
        # Store template agent configuration for creating fresh instances
        self._model = agent.model
        self._system_prompt = agent.system_prompt
        self._tools = (
            list(agent.tool_registry.registry.values())
            if hasattr(agent, "tool_registry")
            else []
        )
        self._agent_kwargs = {
            "record_direct_tool_call": agent.record_direct_tool_call
            if hasattr(agent, "record_direct_tool_call")
            else True,
        }

        self.name = name
        self.description = description
        self.config = config or StrandsAgentConfig()

        # Dictionary to store agent instances per thread
        self._agents_by_thread: Dict[str, StrandsAgentCore] = {}

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Strands agent and yield AG-UI events."""

        # Get or create agent instance for this thread
        # Each thread (user session) maintains its own conversation state
        thread_id = input_data.thread_id or "default"
        if thread_id not in self._agents_by_thread:
            self._agents_by_thread[thread_id] = StrandsAgentCore(
                model=self._model,
                system_prompt=self._system_prompt,
                tools=self._tools,
                **self._agent_kwargs,
            )
        strands_agent = self._agents_by_thread[thread_id]

        # Start run
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        try:
            # Emit state snapshot if provided
            if hasattr(input_data, "state") and input_data.state is not None:
                # Filter out messages from state to avoid "Unknown message role" errors
                # The frontend manages messages separately and doesn't recognize "tool" role
                state_snapshot = {
                    k: v for k, v in input_data.state.items() if k != "messages"
                }
                yield StateSnapshotEvent(
                    type=EventType.STATE_SNAPSHOT, snapshot=state_snapshot
                )

            # Extract frontend tool names from input_data.tools
            frontend_tool_names = set()
            if input_data.tools:
                for tool_def in input_data.tools:
                    tool_name = (
                        tool_def.get("name")
                        if isinstance(tool_def, dict)
                        else getattr(tool_def, "name", None)
                    )
                    if tool_name:
                        frontend_tool_names.add(tool_name)

            # Check if the last message is a tool result - if so, don't emit tool events again
            has_pending_tool_result = False
            if input_data.messages:
                last_msg = input_data.messages[-1]
                if last_msg.role == "tool":
                    has_pending_tool_result = True
                    logger.debug(
                        f"Has pending tool result detected: tool_call_id={getattr(last_msg, 'tool_call_id', 'unknown')}, thread_id={input_data.thread_id}"
                    )

            # Convert AG-UI messages to Strands format
            # Strands expects content as List[ContentBlock] for most messages
            # OpenAI requires tool messages to follow assistant messages with tool_calls
            strands_messages = []
            last_msg_had_tool_calls = False
            expected_tool_call_ids = set()  # Track which tool_call_ids are valid

            logger.debug(
                f"Converting {len(input_data.messages)} messages to Strands format, thread_id={input_data.thread_id}"
            )

            for i, msg in enumerate(input_data.messages):
                logger.debug(
                    f"Message {i}: role={msg.role}, has_tool_calls={hasattr(msg, 'tool_calls') and bool(msg.tool_calls)}, tool_call_id={getattr(msg, 'tool_call_id', None)}"
                )
                strands_msg: Dict[str, Any] = {"role": msg.role}

                # Handle assistant messages with tool_calls
                if (
                    msg.role == "assistant"
                    and hasattr(msg, "tool_calls")
                    and msg.tool_calls
                ):
                    # Convert tool calls to format expected by Strands/OpenAI
                    strands_msg["content"] = []
                    if msg.content:
                        if isinstance(msg.content, str):
                            strands_msg["content"].append({"text": msg.content})
                        elif isinstance(msg.content, list):
                            strands_msg["content"] = msg.content

                    strands_msg["tool_calls"] = []
                    expected_tool_call_ids.clear()  # Reset for this assistant message
                    for tc in msg.tool_calls:
                        expected_tool_call_ids.add(tc.id)  # Track this tool call ID
                        strands_msg["tool_calls"].append(
                            {
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.function.get("name")
                                    if isinstance(tc.function, dict)
                                    else tc.function.name,
                                    "arguments": tc.function.get("arguments")
                                    if isinstance(tc.function, dict)
                                    else tc.function.arguments,
                                },
                            }
                        )
                    last_msg_had_tool_calls = True
                    strands_messages.append(strands_msg)

                # Handle tool messages (must follow assistant message with tool_calls)
                elif msg.role == "tool":
                    # Skip tool messages that don't have a preceding assistant message with tool_calls
                    if (
                        not last_msg_had_tool_calls
                        or msg.tool_call_id not in expected_tool_call_ids
                    ):
                        logger.debug(
                            f"Skipping orphaned tool message: tool_call_id={msg.tool_call_id}, last_msg_had_tool_calls={last_msg_had_tool_calls}, valid_ids={expected_tool_call_ids}, thread_id={input_data.thread_id}"
                        )
                        continue

                    # Include the tool message for OpenAI format compliance
                    strands_msg["tool_call_id"] = msg.tool_call_id
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    else:
                        strands_msg["content"] = msg.content

                    expected_tool_call_ids.remove(msg.tool_call_id)
                    if not expected_tool_call_ids:
                        last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

                # Handle regular messages (user, assistant without tool_calls)
                else:
                    if isinstance(msg.content, str):
                        strands_msg["content"] = [{"text": msg.content}]
                    elif isinstance(msg.content, list):
                        strands_msg["content"] = msg.content
                    else:
                        strands_msg["content"] = [{"text": ""}]
                    last_msg_had_tool_calls = False
                    strands_messages.append(strands_msg)

            # Get the latest user message for state context builder
            user_message = "Hello"
            if input_data.messages:
                for msg in reversed(input_data.messages):
                    if (msg.role == "user" or msg.role == "tool") and msg.content:
                        user_message = msg.content
                        break

            # Optionally allow configuration to adjust the outgoing user message
            if self.config.state_context_builder:
                try:
                    user_message = self.config.state_context_builder(
                        input_data, user_message
                    )
                    # If state_context_builder modifies the message, update the last user message
                    if strands_messages and strands_messages[-1]["role"] == "user":
                        strands_messages[-1]["content"] = [{"text": user_message}]
                except Exception as e:
                    # If the builder fails, keep the original message
                    logger.warning(f"State context builder failed: {e}", exc_info=True)

            # Generate unique message ID
            message_id = str(uuid.uuid4())
            message_started = False
            tool_calls_seen = {}
            stop_text_streaming = False
            halt_event_stream = False

            logger.debug(
                f"Starting agent run: thread_id={input_data.thread_id}, run_id={input_data.run_id}, has_pending_tool_result={has_pending_tool_result}, message_count={len(input_data.messages)}, strands_message_count={len(strands_messages)}"
            )

            # Stream from persistent Strands agent with only the new user message
            # The agent maintains its own conversation history internally
            agent_stream = strands_agent.stream_async(user_message)

            try:
                async for event in agent_stream:
                    # If we've halted, consume remaining events silently to allow proper cleanup
                    if halt_event_stream:
                        continue

                    logger.debug(f"Received event: {event}")

                    # Skip lifecycle events
                    if event.get("init_event_loop") or event.get("start_event_loop"):
                        continue
                    if event.get("complete") or event.get("force_stop"):
                        logger.debug(
                            f"Breaking event stream: received complete or force_stop event (thread_id={input_data.thread_id}, complete={event.get('complete')}, force_stop={event.get('force_stop')})"
                        )
                        # Generator will end naturally, no need to break
                        break

                    # Handle text streaming
                    if "data" in event and event["data"]:
                        if stop_text_streaming:
                            continue

                        if not message_started:
                            yield TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                message_id=message_id,
                                role="assistant",
                            )
                            message_started = True

                        text_chunk = str(event["data"])
                        yield TextMessageContentEvent(
                            type=EventType.TEXT_MESSAGE_CONTENT,
                            message_id=message_id,
                            delta=text_chunk,
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
                                    if (
                                        isinstance(content_item, dict)
                                        and "text" in content_item
                                    ):
                                        text_content = content_item["text"]
                                        try:
                                            result_data = json.loads(text_content)
                                        except json.JSONDecodeError:
                                            try:
                                                json_text = text_content.replace(
                                                    "'", '"'
                                                )
                                                result_data = json.loads(json_text)
                                            except Exception:
                                                result_data = text_content

                            if not result_tool_id or result_data is None:
                                continue

                            call_info = tool_calls_seen.get(result_tool_id, {})
                            tool_name = call_info.get("name")
                            tool_args = call_info.get("args")
                            tool_input = call_info.get("input")
                            behavior = (
                                self.config.tool_behaviors.get(tool_name)
                                if tool_name
                                else None
                            )

                            logger.debug(
                                f"Processing tool result: tool_name={tool_name}, result_tool_id={result_tool_id}, has_pending_tool_result={has_pending_tool_result}, thread_id={input_data.thread_id}"
                            )

                            # Emit ToolCallResultEvent WITHOUT role field to complete the tool in UI
                            # but prevent it from being added to conversation history
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=result_tool_id,
                                message_id=message_id,
                                content=json.dumps(result_data),
                                # role is intentionally omitted - without role="tool",
                                # the frontend won't add this to conversation history
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
                                    snapshot = await maybe_await(
                                        behavior.state_from_result(result_context)
                                    )
                                    if snapshot:
                                        yield StateSnapshotEvent(
                                            type=EventType.STATE_SNAPSHOT,
                                            snapshot=snapshot,
                                        )
                                except Exception as e:
                                    logger.warning(
                                        f"state_from_result failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.custom_result_handler:
                                try:
                                    async for (
                                        custom_event
                                    ) in behavior.custom_result_handler(result_context):
                                        if custom_event is not None:
                                            yield custom_event
                                except Exception as e:
                                    logger.warning(
                                        f"custom_result_handler failed for {tool_name}: {e}",
                                        exc_info=True,
                                    )

                            if behavior and behavior.stop_streaming_after_result:
                                stop_text_streaming = True
                                if message_started:
                                    yield TextMessageEndEvent(
                                        type=EventType.TEXT_MESSAGE_END,
                                        message_id=message_id,
                                    )
                                    message_started = False
                                halt_event_stream = True
                                logger.debug(
                                    f"Breaking event stream: stop_streaming_after_result behavior triggered (thread_id={input_data.thread_id}, tool_name={tool_name})"
                                )
                                # Continue consuming events silently to allow proper cleanup
                                continue

                    # Handle tool calls
                    elif "current_tool_use" in event and event["current_tool_use"]:
                        tool_use = event["current_tool_use"]
                        tool_name = tool_use.get("name")
                        strands_tool_id = tool_use.get("toolUseId")

                        # Generate unique ID for frontend tools (to avoid ID conflicts across requests)
                        # Use Strands' ID for backend tools (so result lookup works)
                        is_frontend_tool = tool_name in frontend_tool_names

                        # Check if we've already seen this tool (by Strands' internal ID)
                        existing_entry = None
                        for tid, data in tool_calls_seen.items():
                            if data.get("strands_tool_id") == strands_tool_id:
                                existing_entry = tid
                                break

                        if existing_entry:
                            # Reuse the existing ID
                            tool_use_id = existing_entry
                        elif is_frontend_tool:
                            # Generate new UUID for frontend tools
                            tool_use_id = str(uuid.uuid4())
                        else:
                            # Use Strands' ID for backend tools
                            tool_use_id = strands_tool_id or str(uuid.uuid4())

                        logger.debug(
                            f"Tool call event received: tool_name={tool_name}, tool_use_id={tool_use_id}, strands_id={strands_tool_id}, is_frontend={is_frontend_tool}, already_seen={tool_use_id in tool_calls_seen}, thread_id={input_data.thread_id}"
                        )

                        # Update tool input as it streams in
                        tool_input_raw = tool_use.get("input", "")

                        # Try to parse as JSON if it looks complete
                        tool_input = {}
                        if isinstance(tool_input_raw, str) and tool_input_raw:
                            try:
                                tool_input = json.loads(tool_input_raw)
                            except json.JSONDecodeError:
                                # Input is still streaming, keep as string
                                tool_input = tool_input_raw
                        elif isinstance(tool_input_raw, dict):
                            tool_input = tool_input_raw

                        args_str = (
                            json.dumps(tool_input)
                            if isinstance(tool_input, dict)
                            else str(tool_input)
                        )

                        # Track or update tool call as input streams in
                        is_new_tool_call = (
                            tool_name and tool_use_id not in tool_calls_seen
                        )
                        if is_new_tool_call:
                            tool_calls_seen[tool_use_id] = {
                                "name": tool_name,
                                "args": args_str,
                                "input": tool_input,
                                "emitted": False,  # Track if we've emitted events
                                "strands_tool_id": strands_tool_id,
                            }
                        elif tool_name and tool_use_id in tool_calls_seen:
                            # Update the input and args as they stream in
                            tool_calls_seen[tool_use_id]["input"] = tool_input
                            tool_calls_seen[tool_use_id]["args"] = args_str

                    # Handle content block stop - this signals tool input is complete
                    elif "event" in event and isinstance(event.get("event"), dict):
                        inner_event = event["event"]
                        if "contentBlockStop" in inner_event:
                            # Find the most recent tool call that hasn't been emitted yet
                            tool_name = None
                            tool_input = None
                            args_str = None
                            tool_use_id = None

                            for tid, tool_data in tool_calls_seen.items():
                                if not tool_data.get("emitted", True):
                                    tool_name = tool_data["name"]
                                    tool_input = tool_data["input"]
                                    args_str = tool_data["args"]
                                    tool_use_id = tid
                                    break  # Process one tool at a time

                            # Only process if we found a tool to emit
                            if tool_name and tool_use_id:
                                # Mark as emitted
                                tool_calls_seen[tool_use_id]["emitted"] = True

                                is_frontend_tool = tool_name in frontend_tool_names
                                behavior = self.config.tool_behaviors.get(tool_name)

                                logger.debug(
                                    f"Processing tool call on contentBlockStop: tool_name={tool_name}, tool_use_id={tool_use_id}, is_frontend_tool={is_frontend_tool}, has_pending_tool_result={has_pending_tool_result}, args_str={args_str}, thread_id={input_data.thread_id}"
                                )
                                call_context = ToolCallContext(
                                    input_data=input_data,
                                    tool_name=tool_name,
                                    tool_use_id=tool_use_id,
                                    tool_input=tool_input,
                                    args_str=args_str,
                                )

                                if behavior and behavior.state_from_args:
                                    try:
                                        snapshot = await maybe_await(
                                            behavior.state_from_args(call_context)
                                        )
                                        if snapshot:
                                            yield StateSnapshotEvent(
                                                type=EventType.STATE_SNAPSHOT,
                                                snapshot=snapshot,
                                            )
                                    except Exception as e:
                                        logger.warning(
                                            f"state_from_args failed for {tool_name}: {e}",
                                            exc_info=True,
                                        )

                                if behavior:
                                    predict_state_payload = [
                                        mapping.to_payload()
                                        for mapping in normalize_predict_state(
                                            behavior.predict_state
                                        )
                                    ]
                                    if predict_state_payload:
                                        yield CustomEvent(
                                            type=EventType.CUSTOM,
                                            name="PredictState",
                                            value=predict_state_payload,
                                        )
                                if has_pending_tool_result:
                                    logger.debug(
                                        f"Skipping tool call START event due to has_pending_tool_result for {tool_name} (tool_use_id={tool_use_id}, thread_id={input_data.thread_id})"
                                    )

                                if not has_pending_tool_result:
                                    logger.debug(
                                        f"Emitting tool call events for {tool_name} (tool_use_id={tool_use_id}, thread_id={input_data.thread_id})"
                                    )
                                    yield ToolCallStartEvent(
                                        type=EventType.TOOL_CALL_START,
                                        tool_call_id=tool_use_id,
                                        tool_call_name=tool_name,
                                        parent_message_id=message_id,
                                    )

                                    if behavior and behavior.args_streamer:
                                        try:
                                            async for chunk in behavior.args_streamer(
                                                call_context
                                            ):
                                                if chunk is None:
                                                    continue
                                                yield ToolCallArgsEvent(
                                                    type=EventType.TOOL_CALL_ARGS,
                                                    tool_call_id=tool_use_id,
                                                    delta=str(chunk),
                                                )
                                        except Exception as e:
                                            logger.warning(
                                                f"args_streamer failed for {tool_name}, falling back to full args: {e}"
                                            )
                                            yield ToolCallArgsEvent(
                                                type=EventType.TOOL_CALL_ARGS,
                                                tool_call_id=tool_use_id,
                                                delta=args_str,
                                            )
                                    else:
                                        yield ToolCallArgsEvent(
                                            type=EventType.TOOL_CALL_ARGS,
                                            tool_call_id=tool_use_id,
                                            delta=args_str,
                                        )

                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_use_id,
                                    )

                                    if is_frontend_tool and not (
                                        behavior
                                        and behavior.continue_after_frontend_call
                                    ):
                                        logger.debug(
                                            f"Breaking event stream: frontend tool call completed (thread_id={input_data.thread_id}, tool_name={tool_name}, tool_call_id={tool_use_id}, has_behavior={behavior is not None}, continue_after_frontend_call={behavior.continue_after_frontend_call if behavior else None})"
                                        )
                                        halt_event_stream = True
                                        # Continue consuming events silently to allow proper cleanup
                                        continue
            finally:
                # Properly close the async generator to avoid context detachment errors
                # The generator should complete naturally when we consume all events,
                # but we still try to close it explicitly to be safe
                try:
                    # Check if generator is already closed/exhausted
                    if not agent_stream.ag_running:
                        # Generator is already closed, nothing to do
                        pass
                    else:
                        # Try to close gracefully, but suppress context-related errors
                        await agent_stream.aclose()
                except (
                    GeneratorExit,
                    ValueError,
                    RuntimeError,
                    StopAsyncIteration,
                ) as e:
                    # Suppress context detachment errors - they occur when the generator
                    # is closed in a different context, but don't affect functionality
                    # These errors are logged by Strands internally, we just prevent them from propagating
                    pass
                except AttributeError:
                    # Generator doesn't have ag_running attribute (older Python versions)
                    # Just try to close it
                    try:
                        await agent_stream.aclose()
                    except (
                        GeneratorExit,
                        ValueError,
                        RuntimeError,
                        StopAsyncIteration,
                    ):
                        pass
                except Exception as e:
                    # Log other errors but don't fail
                    logger.warning(f"Error closing agent stream: {e}")

            # End message if started
            if message_started:
                yield TextMessageEndEvent(
                    type=EventType.TEXT_MESSAGE_END, message_id=message_id
                )

            # Always finish the run - frontend handles keeping action executing
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        except Exception as e:
            import traceback

            traceback.print_exc()
            yield RunErrorEvent(
                type=EventType.RUN_ERROR, message=str(e), code="STRANDS_ERROR"
            )
