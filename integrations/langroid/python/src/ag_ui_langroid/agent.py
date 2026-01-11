"""Langroid Agent implementation for AG-UI.

Simple adapter that bridges Langroid ChatAgent/Task with the AG-UI protocol.
"""

import json
import logging
import uuid
from typing import Any, AsyncIterator, Dict, List, Optional

logger = logging.getLogger(__name__)

from ag_ui.core import (
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
    MessagesSnapshotEvent,
    AssistantMessage,
    ToolMessage,
    ToolCall,
    FunctionCall,
    BaseEvent,
)

from .types import LangroidAgentConfig, ToolBehavior, ToolCallContext, maybe_await


class LangroidAgent:
    """Langroid Agent wrapper for AG-UI integration.
    
    Wraps a Langroid ChatAgent or Task to work with AG-UI protocol.
    """

    def __init__(
        self,
        agent: Any,  # langroid.ChatAgent or langroid.Task
        name: str,
        description: str = "",
        config: Optional[LangroidAgentConfig] = None,
    ):
        """
        Initialize Langroid agent adapter.

        Args:
            agent: Langroid ChatAgent or Task instance
            name: Agent name identifier
            description: Agent description
            config: Optional configuration for customizing behavior
        """
        self._agent = agent
        self.name = name
        self.description = description
        self.config = config or LangroidAgentConfig()

        # Store agent instances per thread for conversation state
        self._agents_by_thread: Dict[str, Any] = {}
        # Track executed tool calls per thread to prevent loops
        self._executed_tool_calls: Dict[str, set] = {}  # thread_id -> set of tool_call_ids

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[Any]:
        """Run the Langroid agent and yield AG-UI events."""
        
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=input_data.thread_id,
            run_id=input_data.run_id,
        )

        try:
            # Emit state snapshot if provided
            if hasattr(input_data, "state") and input_data.state is not None:
                state_snapshot = {
                    k: v for k, v in input_data.state.items() if k != "messages"
                }
                if state_snapshot:
                    yield StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT, snapshot=state_snapshot
                    )

            # Extract frontend tool names
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
                logger.info(f"📋 Frontend tools detected: {frontend_tool_names}")
            else:
                logger.debug("No frontend tools provided in input_data.tools")

            # Get or create agent for this thread
            thread_id = input_data.thread_id or "default"
            if thread_id not in self._agents_by_thread:
                self._agents_by_thread[thread_id] = self._get_agent_instance()

            langroid_agent = self._agents_by_thread[thread_id]

            # Extract user message
            user_message = self._extract_user_message(input_data.messages)
            
            # Apply state context builder if configured (for shared state pattern)
            if self.config:
                state_context_builder = self.config.get("state_context_builder") if isinstance(self.config, dict) else getattr(self.config, "state_context_builder", None)
                if state_context_builder and callable(state_context_builder):
                    user_message = state_context_builder(input_data, user_message)
                    logger.debug(f"Applied state_context_builder, modified user message length: {len(user_message)}")

            message_id = str(uuid.uuid4())
            message_started = False

            # IMPORTANT: Check if the last message is a tool result
            # If so, this is a follow-up request after tool execution - don't execute tools again!
            has_pending_tool_result = False
            if input_data.messages:
                last_msg = input_data.messages[-1]
                if hasattr(last_msg, "role") and last_msg.role == "tool":
                    has_pending_tool_result = True
                    logger.info(f"🔍 Last message is a tool result (tool_call_id={getattr(last_msg, 'tool_call_id', 'unknown')}) - this is a follow-up request, will generate text response instead of calling tools")
                elif hasattr(last_msg, "toolCallId") and last_msg.toolCallId:
                    has_pending_tool_result = True
                    logger.info(f"🔍 Last message has toolCallId={last_msg.toolCallId} - this is a follow-up request, will generate text response instead of calling tools")

            # Get response from Langroid agent
            # Use Task.run() for proper tool execution, or manually handle the conversation loop
            try:
                # Get the actual ChatAgent (Task wraps an agent)
                actual_agent = langroid_agent
                task = None
                if hasattr(langroid_agent, "agent"):
                    # This is a Task
                    task = langroid_agent
                    actual_agent = langroid_agent.agent
                
                if not hasattr(actual_agent, "llm_response"):
                    raise ValueError("Agent must be a ChatAgent or Task with a ChatAgent")
                
                # Step 1: Get initial LLM response
                # IMPORTANT: Track if we've already executed a tool in this run to prevent loops
                tool_executed_this_run = False
                
                # For agentic generative UI: we need to continue processing in a loop to handle multiple tool calls
                # Track the number of iterations to prevent infinite loops
                max_iterations = 20  # Reasonable limit for a plan with multiple steps
                iteration_count = 0
                
                # If we have a pending tool result, use an empty message or the tool result message
                # This tells Langroid to process the tool result and generate a text response
                llm_response_input = "" if has_pending_tool_result else user_message
                llm_response = actual_agent.llm_response(llm_response_input)

                # Handle response
                if llm_response is None:
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="Agent returned None",
                        code="LANGROID_ERROR",
                    )
                    return

                # Step 2: Check if LLM wants to call a tool
                # IMPORTANT: If we have a pending tool result, skip tool detection - just generate text response
                # This prevents loops where tool results trigger another tool call
                tool_call_detected = False
                tool_call_message = None
                parsed_tool_call_from_content = None
                
                # First, extract response content
                response_content = ""
                if hasattr(llm_response, "content"):
                    response_content = str(llm_response.content) if llm_response.content else ""
                elif isinstance(llm_response, str):
                    response_content = llm_response
                else:
                    response_content = str(llm_response)
                
                logger.debug(f"📝 LLM response received: content_length={len(response_content)}, preview={response_content[:200] if response_content else 'None'}")
                
                # IMPORTANT: If we have a pending tool result, skip tool detection - just generate text response
                # This prevents loops where tool results trigger another tool call
                if has_pending_tool_result:
                    logger.info("⏭️ Skipping tool detection - last message is a tool result, will only generate text response")
                else:
                    # Quick check: Does content look like it contains a tool call?
                    # Look for JSON with "request" field (any tool call pattern)
                    # This must happen BEFORE we check message_history to catch tool calls returned as text
                    if response_content:
                        content_stripped = response_content.strip()
                        # Check for tool call patterns: ```json\n{...} or {...} with "request" field
                        if "```json" in content_stripped or ('{"request"' in content_stripped or '"request"' in content_stripped):
                            json_start = content_stripped.find("{")
                            if json_start >= 0:
                                # Find the complete JSON object by counting braces
                                brace_count = 0
                                json_end = -1
                                for i in range(json_start, len(content_stripped)):
                                    if content_stripped[i] == '{':
                                        brace_count += 1
                                    elif content_stripped[i] == '}':
                                        brace_count -= 1
                                        if brace_count == 0:
                                            json_end = i + 1
                                            break
                                
                                if json_end > json_start:
                                    try:
                                        json_str = content_stripped[json_start:json_end]
                                        potential_tool_call = json.loads(json_str)
                                        if isinstance(potential_tool_call, dict) and "request" in potential_tool_call:
                                            parsed_tool_call_from_content = potential_tool_call
                                            logger.info(f"✅ Tool call detected in response content (early check): {parsed_tool_call_from_content}")
                                            # Mark that we found a tool call in content - this will prevent text emission
                                    except json.JSONDecodeError as e:
                                        logger.debug(f"Failed to parse JSON tool call: {e}")
                    
                    # Check the llm_response return value first for tool calls
                    # Langroid's llm_response may return a response with tool_calls attribute
                    if hasattr(llm_response, "tool_calls") and llm_response.tool_calls:
                        logger.info(f"✅ Tool calls found in llm_response.tool_calls: {llm_response.tool_calls}")
                        # Extract first tool call if present
                        # Note: Langroid uses ToolMessage in message_history, so we'll check that next
                    
                    # Check message history for tool calls - Langroid adds ToolMessage instances here
                    # IMPORTANT: Also check if the last message is a tool result - if so, skip tool detection
                    if hasattr(actual_agent, "message_history"):
                        history = actual_agent.message_history
                        if history:
                            logger.debug(f"Checking message history after llm_response, length: {len(history)}")
                            
                            # Check if the last message is a tool result (means we just executed a tool)
                            # If so, skip tool detection to prevent loop
                            last_msg = history[-1] if history else None
                            if last_msg:
                                last_msg_str = str(last_msg).lower()
                                last_msg_type = type(last_msg).__name__
                                # Check if it looks like a tool result (contains JSON with temperature, conditions, etc.)
                                if ("temperature" in last_msg_str and "conditions" in last_msg_str) or \
                                   ("chart_type" in last_msg_str) or \
                                   (hasattr(last_msg, "content") and isinstance(last_msg.content, str) and 
                                    ("temperature" in last_msg.content.lower() or "chart_type" in last_msg.content.lower())):
                                    logger.info(f"⏭️ Last message in history appears to be a tool result (type={last_msg_type}) - skipping tool detection to prevent loop")
                                    tool_call_detected = False
                                else:
                                    # Look for ToolMessage instances (these are tool calls from LLM)
                                    # Langroid adds these AFTER llm_response() when tools are requested
                                    for msg in reversed(history[-10:]):
                                        msg_type = type(msg).__name__
                                        msg_str = str(msg)[:200] if hasattr(msg, "__str__") else str(type(msg))
                                        logger.debug(f"Message in history: type={msg_type}, str_repr={msg_str}")
                                        
                                        # ToolMessage instances have 'request' and 'purpose' fields
                                        if hasattr(msg, "request") and hasattr(msg, "purpose"):
                                            # This is a tool call from the LLM
                                            tool_call_detected = True
                                            tool_call_message = msg
                                            logger.info(f"✅ Tool call detected in message_history: request={msg.request}, type={msg_type}, full_dict={msg.__dict__}")
                                            break
                                        # Also check for messages that might be tool-related
                                        elif "Tool" in msg_type or "tool" in msg_type.lower():
                                            logger.debug(f"Found tool-related message type: {msg_type}, checking attributes: {dir(msg)[:10]}")
                                            if hasattr(msg, "request"):
                                                tool_call_detected = True
                                                tool_call_message = msg
                                                logger.info(f"✅ Tool call detected via type check: {msg.request}")
                                                break
                            
                            if not tool_call_detected:
                                logger.debug(f"No tool calls found in message history. Last 5 messages: {[type(m).__name__ for m in history[-5:]]}")
                        else:
                            logger.debug("Message history is empty after llm_response")
                    else:
                        logger.warning("Agent does not have message_history attribute")
                    
                    # If we found a tool call in content but not in message_history, use the one from content
                    if not tool_call_detected and parsed_tool_call_from_content:
                        tool_call_detected = True
                        # Create a mock tool call message for consistency with message_history path
                        class ParsedToolMessage:
                            def __init__(self, request, **kwargs):
                                self.request = request
                                self.purpose = ""  # Required field for ToolMessage
                                for k, v in kwargs.items():
                                    setattr(self, k, v)
                        tool_call_message = ParsedToolMessage(
                            request=parsed_tool_call_from_content.get("request"), 
                            **{k: v for k, v in parsed_tool_call_from_content.items() if k != "request"}
                        )
                        logger.info(f"✅ Using tool call parsed from content (not in message_history): {tool_call_message.request}")

                # Step 3: Handle tool calls or regular text response
                if tool_call_detected and tool_call_message:
                    # Extract tool information
                    tool_name = tool_call_message.request
                    tool_args = {}
                    for field_name, field_value in tool_call_message.__dict__.items():
                        if field_name not in ["request", "purpose"]:
                            tool_args[field_name] = field_value
                    
                    # IMPORTANT: Check if this tool has already been executed by checking message_history for result
                    # This prevents loops where the same tool call gets executed multiple times
                    tool_already_executed = False
                    if hasattr(actual_agent, "message_history") and actual_agent.message_history:
                        history = actual_agent.message_history
                        # Look for tool results (messages that contain the tool result JSON)
                        for msg in reversed(history[-5:]):
                            msg_content = str(msg) if hasattr(msg, "__str__") else ""
                            # Check if this message contains a result for this tool (look for tool result indicators)
                            if tool_name == "get_weather" and ("temperature" in msg_content.lower() and tool_args.get("location", "").lower() in msg_content.lower()):
                                tool_already_executed = True
                                logger.warning(f"⚠️ Tool {tool_name} appears to have already been executed (found result in message_history) - skipping to prevent loop")
                                break
                            elif tool_name == "render_chart" and ("chart_type" in msg_content.lower() or "rendered" in msg_content.lower()):
                                tool_already_executed = True
                                logger.warning(f"⚠️ Tool {tool_name} appears to have already been executed (found result in message_history) - skipping to prevent loop")
                                break
                    
                    if tool_already_executed:
                        # Tool already executed - just generate a text response instead
                        logger.info(f"⏭️ Tool {tool_name} already executed - generating text response instead")
                        tool_call_detected = False
                        # Continue to text response generation below - skip all tool execution logic
                    else:
                        # Tool hasn't been executed yet - proceed with normal tool handling
                        # Check if it's a frontend tool (from input_data.tools or if no handler method exists)
                        is_frontend_tool = tool_name in frontend_tool_names
                        
                        # Fallback: If tool is not in frontend_tool_names, check if agent has a handler method
                        # If no handler method exists, treat it as frontend tool
                        if not is_frontend_tool and tool_name:
                            has_handler = hasattr(actual_agent, tool_name) and callable(getattr(actual_agent, tool_name, None))
                            # Also check task.agent if task exists
                            if not has_handler and task is not None and hasattr(task, "agent"):
                                task_agent = task.agent
                                has_handler = hasattr(task_agent, tool_name) and callable(getattr(task_agent, tool_name, None))
                            
                            if not has_handler:
                                logger.info(f"🔍 Tool {tool_name} has no handler method - treating as frontend tool")
                                is_frontend_tool = True
                        
                        logger.info(
                            f"Processing tool call: name={tool_name}, "
                            f"args={tool_args}, "
                            f"frontend_tools={frontend_tool_names}, "
                            f"is_frontend_tool={is_frontend_tool}"
                        )
                        
                        tool_call_id = str(uuid.uuid4())
                        
                        # If frontend tool, emit events and continue to generate confirmation message
                        if is_frontend_tool:
                            logger.info(f"✅ Frontend tool detected in message_history: {tool_name} - emitting events")
                            args_str = json.dumps(tool_args)
                            
                            # Emit tool call events directly (CopilotKit will create the assistant message automatically)
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_call_id,
                                tool_call_name=tool_name,
                                parent_message_id=message_id,
                            )
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_call_id,
                                delta=args_str,
                            )
                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_call_id,
                            )
                            
                            logger.info(f"✅ Frontend tool {tool_name} events emitted - CopilotKit will execute tool automatically")
                            # Emit RunFinishedEvent to signal run completion - CopilotKit will execute the tool when it receives ToolCallEndEvent
                            yield RunFinishedEvent(
                                type=EventType.RUN_FINISHED,
                                thread_id=input_data.thread_id,
                                run_id=input_data.run_id,
                            )
                            return
                        
                        # For backend tools: Emit START -> ARGS -> (execute tool) -> RESULT -> END (like LangGraph)
                        # This ensures CopilotKit can properly track and render the tool call
                        else:
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_call_id,
                                tool_call_name=tool_name,
                                parent_message_id=message_id,
                            )
                            
                            # Emit tool arguments (CopilotKit needs this to construct the tool call display)
                            args_str = json.dumps(tool_args)
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_call_id,
                                delta=args_str,
                            )
                            
                            # Check for state_from_args handler (for shared state pattern)
                            # This emits state snapshot when tool is called with arguments
                            if self.config:
                                tool_behaviors = self.config.get("tool_behaviors", {}) if isinstance(self.config, dict) else getattr(self.config, "tool_behaviors", {})
                                behavior = tool_behaviors.get(tool_name) if isinstance(tool_behaviors, dict) else None
                                
                                if behavior and isinstance(behavior, ToolBehavior) and behavior.state_from_args:
                                    try:
                                        import inspect
                                        
                                        # Create context for state_from_args
                                        tool_call_context = ToolCallContext(
                                            input_data=input_data,
                                            tool_name=tool_name,
                                            tool_call_id=tool_call_id,
                                            tool_input=tool_call_message,
                                            args_str=args_str,
                                        )
                                        
                                        # Call state_from_args handler
                                        snapshot = behavior.state_from_args(tool_call_context)
                                        snapshot = await maybe_await(snapshot)
                                        
                                        if snapshot:
                                            yield StateSnapshotEvent(
                                                type=EventType.STATE_SNAPSHOT,
                                                snapshot=snapshot,
                                            )
                                            logger.info(f"✅ Emitted state snapshot from state_from_args for {tool_name}")
                                    except Exception as e:
                                        logger.warning(f"state_from_args failed for {tool_name}: {e}", exc_info=True)
                            
                            # Now execute the tool method (before emitting END and RESULT)
                            # Following Langroid pattern: tool methods match the tool's request field name
                            logger.info(f"Executing backend tool method: {tool_name}")
                            tool_result_content = None
                            
                            try:
                                # actual_agent should already be the correct agent (ChatAgent from Task)
                                # Call the tool method directly - it's already enabled via enable_message()
                                logger.debug(f"Checking agent {type(actual_agent).__name__} for method {tool_name}")
                                
                                if hasattr(actual_agent, tool_name):
                                    tool_method = getattr(actual_agent, tool_name)
                                    if callable(tool_method):
                                        try:
                                            logger.info(f"✅ Executing tool method {tool_name} on {type(actual_agent).__name__} with message: {tool_call_message}")
                                            # Call with the ToolMessage instance (tool_call_message)
                                            method_result = tool_method(tool_call_message)
                                            
                                            # Convert method result to JSON string for Langroid
                                            if isinstance(method_result, str):
                                                tool_result_content = method_result
                                                try:
                                                    result_data = json.loads(method_result)
                                                except:
                                                    result_data = {"result": method_result}
                                            elif isinstance(method_result, dict):
                                                tool_result_content = json.dumps(method_result)
                                                result_data = method_result
                                            else:
                                                tool_result_content = json.dumps({"result": str(method_result)})
                                                result_data = {"result": str(method_result)}
                                            
                                            logger.info(f"✅ Tool {tool_name} executed successfully, result length: {len(tool_result_content)}")
                                                
                                        except Exception as method_err:
                                            logger.error(f"❌ Error calling tool method {tool_name}: {method_err}", exc_info=True)
                                            tool_result_content = None
                                            result_data = None
                                    else:
                                        logger.error(f"❌ Method {tool_name} exists but is not callable. Type: {type(tool_method)}")
                                else:
                                    # Debug: list available methods
                                    all_attrs = dir(actual_agent)
                                    callable_methods = [m for m in all_attrs if not m.startswith('_') and callable(getattr(actual_agent, m, None))]
                                    logger.error(f"❌ Method {tool_name} not found on {type(actual_agent).__name__}")
                                    logger.debug(f"Available callable methods: {callable_methods[:15]}")
                                    
                                    # Try to find it on task.agent if task exists
                                    if task is not None and hasattr(task, "agent"):
                                        task_agent = task.agent
                                        logger.debug(f"Trying task.agent ({type(task_agent).__name__})")
                                        if hasattr(task_agent, tool_name):
                                            tool_method = getattr(task_agent, tool_name)
                                            if callable(tool_method):
                                                try:
                                                    logger.info(f"✅ Found method on task.agent, executing {tool_name}")
                                                    method_result = tool_method(tool_call_message)
                                                    
                                                    # Check if the result is an AG-UI event (for agentic generative UI)
                                                    if isinstance(method_result, (StateSnapshotEvent, StateDeltaEvent)):
                                                        logger.info(f"✅ Tool {tool_name} returned AG-UI event via task.agent: {type(method_result).__name__}")
                                                        # For agentic generative UI: yield the event directly
                                                        yield method_result
                                                        
                                                        # Emit END after the state event
                                                        yield ToolCallEndEvent(
                                                            type=EventType.TOOL_CALL_END,
                                                            tool_call_id=tool_call_id,
                                                        )
                                                        
                                                        # Return early - the state event has been emitted
                                                        logger.info(f"✅ Agentic generative UI event emitted for {tool_name} - emitting RunFinishedEvent and stopping")
                                                        yield RunFinishedEvent(
                                                            type=EventType.RUN_FINISHED,
                                                            thread_id=input_data.thread_id,
                                                            run_id=input_data.run_id,
                                                        )
                                                        return
                                                    
                                                    # For regular tool results
                                                    if isinstance(method_result, str):
                                                        tool_result_content = method_result
                                                    elif isinstance(method_result, dict):
                                                        tool_result_content = json.dumps(method_result)
                                                    else:
                                                        tool_result_content = json.dumps({"result": str(method_result)})
                                                    logger.info(f"✅ Tool executed via task.agent: {tool_result_content[:200]}")
                                                except Exception as task_err:
                                                    logger.error(f"❌ Error executing via task.agent: {task_err}", exc_info=True)
                                
                                # Emit tool result events
                                # Strategy: Use ToolCallResultEvent only
                                # DO NOT use MessagesSnapshotEvent - it will replace all messages in the chat!
                                if tool_result_content:
                                    logger.info(f"✅ Emitting tool result events for {tool_name} with content length: {len(tool_result_content)}")
                                    
                                    # 1. Emit ToolCallResultEvent (for event-based protocols)
                                    # IMPORTANT: We need role="tool" for CopilotKit to match the result to the action
                                    # Loop prevention is handled by checking message_history and early return after tool execution
                                    yield ToolCallResultEvent(
                                        type=EventType.TOOL_CALL_RESULT,
                                        tool_call_id=tool_call_id,
                                        message_id=str(uuid.uuid4()),  # New message ID for tool result
                                        content=tool_result_content,  # JSON string - CopilotKit will parse and pass to render()
                                        role="tool",  # Required for CopilotKit to match result to actionExecutionId
                                    )
                                    
                                    # Emit END after RESULT - this signals the entire tool call sequence is complete
                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_call_id,
                                    )
                                    
                                    # 2. Check for handler method
                                    # Handler methods follow the pattern: _handle_<tool_name>_result
                                    # They are async generators that yield state events (StateSnapshotEvent, StateDeltaEvent, etc.)
                                    handler_method_name = f"_handle_{tool_name}_result"
                                    if hasattr(actual_agent, handler_method_name):
                                        handler_method = getattr(actual_agent, handler_method_name)
                                        if callable(handler_method):
                                            try:
                                                import inspect
                                                # Check if it's an async generator function
                                                if inspect.isasyncgenfunction(handler_method):
                                                    logger.info(f"✅ Found async generator handler {handler_method_name} for {tool_name} - yielding state events")
                                                    # Call the async generator handler with result_data
                                                    async_gen = handler_method(result_data if result_data else {})
                                                    # Iterate over the async generator to yield all state events
                                                    async for state_event in async_gen:
                                                        if state_event is not None:
                                                            logger.info(f"✅ Yielding state event from handler: {type(state_event).__name__}")
                                                            yield state_event
                                                # Check if it's a regular async function (coroutine)
                                                elif inspect.iscoroutinefunction(handler_method):
                                                    logger.info(f"✅ Found coroutine handler {handler_method_name} for {tool_name}")
                                                    state_event = await handler_method(result_data if result_data else {})
                                                    if state_event is not None:
                                                        logger.info(f"✅ Yielding state event from handler: {type(state_event).__name__}")
                                                        yield state_event
                                                else:
                                                    logger.debug(f"Handler {handler_method_name} exists but is not async generator or coroutine function")
                                            except Exception as handler_err:
                                                logger.warning(f"Handler {handler_method_name} failed for {tool_name}: {handler_err}", exc_info=True)
                                    
                                    # DO NOT emit MessagesSnapshotEvent here - it will replace all messages in the chat!
                                    # ToolCallResultEvent is sufficient for CopilotKit to render the result
                                    # The tool call events (START, ARGS, END) and result event provide all needed info
                                else:
                                    logger.error(f"❌ Could not execute tool {tool_name} - tool_result_content is None after execution attempt")
                                    yield ToolCallResultEvent(
                                        type=EventType.TOOL_CALL_RESULT,
                                        tool_call_id=tool_call_id,
                                        message_id=str(uuid.uuid4()),
                                        content=json.dumps({"error": f"Tool {tool_name} execution failed - no result generated", "tool": tool_name}),
                                        role="tool",  # Required for CopilotKit to match result to actionExecutionId
                                    )
                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_call_id,
                                    )
                                
                                # Check for handler method for agentic generative UI
                                has_handler = hasattr(actual_agent, f"_handle_{tool_name}_result")
                                if has_handler:
                                    handler_method = getattr(actual_agent, f"_handle_{tool_name}_result", None)
                                    has_handler = handler_method and callable(handler_method)
                                
                                # For agentic generative UI tools: handler already yielded all state events
                                # The handler does all the work (processes all steps), so we finish after it completes
                                if has_handler:
                                    logger.info(f"✅ Agentic generative UI tool {tool_name} - handler completed, all state events emitted, finishing run")
                                    # Handler processed everything - finish normally
                                    yield RunFinishedEvent(
                                        type=EventType.RUN_FINISHED,
                                        thread_id=input_data.thread_id,
                                        run_id=input_data.run_id,
                                    )
                                    return
                                
                                # Regular backend tool - let LLM generate response after tool execution
                                # Add tool result to message history, then call llm_response() to generate proper response
                                logger.info(f"✅ Backend tool {tool_name} execution complete - adding result to message history and generating LLM response")
                                
                                try:
                                    # Add tool result to Langroid's message history so LLM can generate a proper response
                                    # For shared state tools like generate_recipe, we need to let the LLM generate a proper response
                                    # instead of using hardcoded responses. We'll add the tool result to message history
                                    # and then call llm_response() to generate a conversational response.
                                    if hasattr(actual_agent, "message_history"):
                                        # Create a simple class to represent the tool result message
                                        # Langroid's message_history can accept various message types
                                        class ToolResultMessage:
                                            def __init__(self, content):
                                                self.content = content
                                        
                                        # Add the tool result to message history
                                        tool_result_message = ToolResultMessage(content=tool_result_content)
                                        actual_agent.message_history.append(tool_result_message)
                                        logger.info(f"✅ Added tool result to message_history, length now: {len(actual_agent.message_history)}")
                                    
                                    # Now call llm_response() to let the LLM generate a proper conversational response
                                    # Pass empty string to indicate we want a response based on the tool result
                                    logger.info(f"✅ Calling llm_response() to generate proper response for tool {tool_name}")
                                    follow_up_response = actual_agent.llm_response("")
                                    
                                    if follow_up_response:
                                        follow_up_content = ""
                                        if hasattr(follow_up_response, "content"):
                                            follow_up_content = str(follow_up_response.content) if follow_up_response.content else ""
                                        elif isinstance(follow_up_response, str):
                                            follow_up_content = follow_up_response
                                        else:
                                            follow_up_content = str(follow_up_response)
                                        
                                        # Check if the response contains another tool call (should not happen, but check to prevent loops)
                                        if follow_up_content and ("request" in follow_up_content.lower() or "tool" in follow_up_content.lower()):
                                            # Response might contain tool call - check message_history to be sure
                                            has_another_tool_call = False
                                            if hasattr(actual_agent, "message_history"):
                                                for msg in reversed(actual_agent.message_history[-5:]):
                                                    if hasattr(msg, "request") and hasattr(msg, "purpose"):
                                                        has_another_tool_call = True
                                                        break
                                            
                                            if has_another_tool_call:
                                                logger.warning(f"⚠️ LLM response contains another tool call - using fallback response instead")
                                                # Use a simple fallback response
                                                if result_data and isinstance(result_data, dict):
                                                    if tool_name == "get_weather":
                                                        location = result_data.get("location", "the location")
                                                        temp = result_data.get("temperature", "N/A")
                                                        conditions = result_data.get("conditions", "unknown")
                                                        humidity = result_data.get("humidity", "N/A")
                                                        wind = result_data.get("wind_speed", "N/A")
                                                        feels_like = result_data.get("feels_like", "N/A")
                                                        follow_up_content = f"The current weather in {location} is {temp}°F with {conditions} conditions. The wind speed is {wind} mph, and the humidity level is at {humidity}%. It feels like {feels_like}°F."
                                                    elif tool_name == "render_chart":
                                                        chart_type = result_data.get("chart_type", "chart")
                                                        status = result_data.get("status", "completed")
                                                        message = result_data.get("message", f"{chart_type} chart has been rendered")
                                                        follow_up_content = f"{message}."
                                                    else:
                                                        follow_up_content = f"I've successfully executed the {tool_name} tool."
                                        
                                        if follow_up_content and follow_up_content.strip():
                                            response_message_id = str(uuid.uuid4())
                                            yield TextMessageStartEvent(
                                                type=EventType.TEXT_MESSAGE_START,
                                                message_id=response_message_id,
                                                role="assistant",
                                            )
                                            
                                            # Stream the response text in chunks
                                            chunk_size = 50
                                            for i in range(0, len(follow_up_content), chunk_size):
                                                chunk = follow_up_content[i:i+chunk_size]
                                                yield TextMessageContentEvent(
                                                    type=EventType.TEXT_MESSAGE_CONTENT,
                                                    message_id=response_message_id,
                                                    delta=chunk,
                                                )
                                            
                                            yield TextMessageEndEvent(
                                                type=EventType.TEXT_MESSAGE_END,
                                                message_id=response_message_id,
                                            )
                                            logger.info(f"✅ LLM-generated response emitted: {follow_up_content[:100]}")
                                    else:
                                        logger.warning(f"⚠️ llm_response() returned None for tool {tool_name}, no response generated")
                                except Exception as text_err:
                                    logger.warning(f"Failed to generate LLM response from tool result: {text_err}", exc_info=True)
                                    # Fallback to simple response
                                    try:
                                        if result_data and isinstance(result_data, dict):
                                            if tool_name == "get_weather":
                                                location = result_data.get("location", "the location")
                                                temp = result_data.get("temperature", "N/A")
                                                conditions = result_data.get("conditions", "unknown")
                                                humidity = result_data.get("humidity", "N/A")
                                                wind = result_data.get("wind_speed", "N/A")
                                                feels_like = result_data.get("feels_like", "N/A")
                                                fallback_text = f"The current weather in {location} is {temp}°F with {conditions} conditions. The wind speed is {wind} mph, and the humidity level is at {humidity}%. It feels like {feels_like}°F."
                                            elif tool_name == "render_chart":
                                                chart_type = result_data.get("chart_type", "chart")
                                                status = result_data.get("status", "completed")
                                                message = result_data.get("message", f"{chart_type} chart has been rendered")
                                                fallback_text = f"{message}."
                                            else:
                                                fallback_text = f"I've successfully executed the {tool_name} tool."
                                            
                                            response_message_id = str(uuid.uuid4())
                                            yield TextMessageStartEvent(
                                                type=EventType.TEXT_MESSAGE_START,
                                                message_id=response_message_id,
                                                role="assistant",
                                            )
                                            yield TextMessageContentEvent(
                                                type=EventType.TEXT_MESSAGE_CONTENT,
                                                message_id=response_message_id,
                                                delta=fallback_text,
                                            )
                                            yield TextMessageEndEvent(
                                                type=EventType.TEXT_MESSAGE_END,
                                                message_id=response_message_id,
                                            )
                                    except Exception as fallback_err:
                                        logger.error(f"Failed to generate fallback response: {fallback_err}", exc_info=True)
                                
                                yield RunFinishedEvent(
                                    type=EventType.RUN_FINISHED,
                                    thread_id=input_data.thread_id,
                                    run_id=input_data.run_id,
                                )
                                return
                                    
                            except Exception as tool_exec_error:
                                logger.error(f"❌ Error in tool execution flow: {tool_exec_error}", exc_info=True)
                                # Still emit a result event so frontend knows something happened
                                yield ToolCallResultEvent(
                                    type=EventType.TOOL_CALL_RESULT,
                                    tool_call_id=tool_call_id,
                                    message_id=message_id,
                                    content=json.dumps({"error": str(tool_exec_error), "tool": tool_name}),
                                    role="tool",  # Required for CopilotKit to match result to actionExecutionId
                                )
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=tool_call_id,
                                )
                                # IMPORTANT: Return early even on error to prevent loop
                                logger.info(f"✅ Backend tool {tool_name} execution failed - emitting RunFinishedEvent and stopping to prevent loop")
                                yield RunFinishedEvent(
                                    type=EventType.RUN_FINISHED,
                                    thread_id=input_data.thread_id,
                                    run_id=input_data.run_id,
                                )
                                return  # IMPORTANT: Return early to prevent loop even on error
                
                else:
                    # No tool call detected in message_history
                    # Check if we found a tool call in content earlier (but not in message_history)
                    # If so, handle it here. Otherwise, emit regular text response.
                    logger.debug(f"No tool call in message_history. response_content length: {len(response_content) if response_content else 0}, parsed_tool_call_from_content: {parsed_tool_call_from_content is not None}")
                    # Always start with response_content - we'll modify it if we find a tool call
                    content = response_content if response_content else ""
                    parsed_tool_call = None
                    
                    logger.debug(f"Initial content for else block: length={len(content)}, preview={content[:100] if content else 'None'}")
                    
                    # If we found a tool call in content earlier but not in message_history, use it
                    if parsed_tool_call_from_content:
                        parsed_tool_call = parsed_tool_call_from_content
                        logger.info(f"✅ Using tool call from early content check (not in message_history): {parsed_tool_call}")
                        # Remove the tool call JSON from content to prevent it from being emitted as text
                        # Extract just the text parts before and after the JSON
                        if content:
                            content_stripped = content.strip()
                            json_start = content_stripped.find("{")
                            if json_start >= 0:
                                brace_count = 0
                                json_end = -1
                                for i in range(json_start, len(content_stripped)):
                                    if content_stripped[i] == '{':
                                        brace_count += 1
                                    elif content_stripped[i] == '}':
                                        brace_count -= 1
                                        if brace_count == 0:
                                            json_end = i + 1
                                            break
                                
                                if json_end > json_start:
                                    # Extract text before and after the JSON
                                    text_before = content_stripped[:json_start].strip()
                                    text_after = content_stripped[json_end:].strip()
                                    # Combine non-empty text parts
                                    remaining_text = " ".join(filter(None, [text_before, text_after])).strip()
                                    content = remaining_text  # Keep any text that's not part of the tool call
                                    logger.debug(f"Extracted text around tool call: before='{text_before}', after='{text_after}', remaining='{content}'")
                    # Final fallback: If we somehow missed the tool call, try parsing again
                    elif content and ("```json" in content or ('{"request"' in content)):
                        content_stripped = content.strip()
                        json_start = content_stripped.find("{")
                        if json_start >= 0:
                            brace_count = 0
                            json_end = -1
                            for i in range(json_start, len(content_stripped)):
                                if content_stripped[i] == '{':
                                    brace_count += 1
                                elif content_stripped[i] == '}':
                                    brace_count -= 1
                                    if brace_count == 0:
                                        json_end = i + 1
                                        break
                            
                            if json_end > json_start:
                                try:
                                    json_str = content_stripped[json_start:json_end]
                                    potential_tool_call = json.loads(json_str)
                                    if isinstance(potential_tool_call, dict) and "request" in potential_tool_call:
                                        parsed_tool_call = potential_tool_call
                                        logger.warning(f"⚠️ Tool call found in else block fallback: {parsed_tool_call}")
                                        # Remove JSON from content
                                        text_before = content_stripped[:json_start].strip()
                                        text_after = content_stripped[json_end:].strip()
                                        remaining_text = " ".join(filter(None, [text_before, text_after])).strip()
                                        content = remaining_text
                                except json.JSONDecodeError:
                                    pass

                    # If we found a tool call in the else block (fallback), handle it
                    if parsed_tool_call:
                        tool_name = parsed_tool_call.get("request")
                        tool_args = {k: v for k, v in parsed_tool_call.items() if k != "request"}
                        
                        # Check if it's a frontend tool (from input_data.tools or if no handler method exists)
                        is_frontend_tool = tool_name in frontend_tool_names if tool_name else False
                        
                        # Fallback: If tool is not in frontend_tool_names, check if agent has a handler method
                        # If no handler method exists, treat it as frontend tool
                        if not is_frontend_tool and tool_name:
                            has_handler = hasattr(actual_agent, tool_name) and callable(getattr(actual_agent, tool_name, None))
                            # Also check task.agent if task exists
                            if not has_handler and task is not None and hasattr(task, "agent"):
                                task_agent = task.agent
                                has_handler = hasattr(task_agent, tool_name) and callable(getattr(task_agent, tool_name, None))
                            
                            if not has_handler:
                                logger.info(f"🔍 Tool {tool_name} has no handler method - treating as frontend tool")
                                is_frontend_tool = True
                        
                        logger.info(f"🔧 Tool call parsed from text: name={tool_name}, args={tool_args}, frontend_tools={frontend_tool_names}, is_frontend={is_frontend_tool}, tool_executed_this_run={tool_executed_this_run}")
                        
                        # Prevent executing the same tool twice in the same run
                        if tool_executed_this_run:
                            logger.warning(f"⚠️ Tool {tool_name} already executed in this run - skipping to prevent loop")
                            yield RunFinishedEvent(
                                type=EventType.RUN_FINISHED,
                                thread_id=input_data.thread_id,
                                run_id=input_data.run_id,
                            )
                            return
                        
                        tool_executed_this_run = True
                        tool_call_id = str(uuid.uuid4())
                        
                        # If frontend tool, emit events and continue to generate confirmation message
                        if is_frontend_tool:
                            logger.info(f"✅ Frontend tool detected: {tool_name} - emitting events")
                            # Clear content immediately to prevent it from being emitted as text
                            content = ""
                            
                            args_str = json.dumps(tool_args)
                            
                            # Emit tool call events directly (CopilotKit will create the assistant message automatically)
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_call_id,
                                tool_call_name=tool_name,
                                parent_message_id=message_id,
                            )
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_call_id,
                                delta=args_str,
                            )
                            yield ToolCallEndEvent(
                                type=EventType.TOOL_CALL_END,
                                tool_call_id=tool_call_id,
                            )
                            
                            logger.info(f"✅ Frontend tool {tool_name} events emitted - CopilotKit will execute tool automatically")
                            # Emit RunFinishedEvent to signal run completion - CopilotKit will execute the tool when it receives ToolCallEndEvent
                            yield RunFinishedEvent(
                                type=EventType.RUN_FINISHED,
                                thread_id=input_data.thread_id,
                                run_id=input_data.run_id,
                            )
                            return
                        
                        # Backend tool: Execute it
                        # Emit START -> ARGS -> execute -> RESULT -> END
                        yield ToolCallStartEvent(
                            type=EventType.TOOL_CALL_START,
                            tool_call_id=tool_call_id,
                            tool_call_name=tool_name,
                            parent_message_id=message_id,
                        )
                        yield ToolCallArgsEvent(
                            type=EventType.TOOL_CALL_ARGS,
                            tool_call_id=tool_call_id,
                            delta=json.dumps(tool_args),
                        )
                        
                        # Execute the tool method
                        tool_result_content = None
                        try:
                            if hasattr(actual_agent, tool_name):
                                tool_method = getattr(actual_agent, tool_name)
                                if callable(tool_method):
                                    # Create a mock ToolMessage object for the method call
                                    # We'll construct it dynamically based on the parsed tool call
                                    class ParsedToolMessage:
                                        def __init__(self, request, **kwargs):
                                            self.request = request
                                            for k, v in kwargs.items():
                                                setattr(self, k, v)
                                    
                                    parsed_tool_msg = ParsedToolMessage(request=tool_name, **tool_args)
                                    method_result = tool_method(parsed_tool_msg)
                                    
                                    # Check if the result is an AG-UI event (for agentic generative UI)
                                    if isinstance(method_result, (StateSnapshotEvent, StateDeltaEvent)):
                                        logger.info(f"✅ Tool {tool_name} returned AG-UI event (from parsed content): {type(method_result).__name__}")
                                        # For agentic generative UI: yield the event directly
                                        yield method_result
                                        
                                        # Emit END after the state event
                                        yield ToolCallEndEvent(
                                            type=EventType.TOOL_CALL_END,
                                            tool_call_id=tool_call_id,
                                        )
                                        
                                        # Return early - the state event has been emitted
                                        logger.info(f"✅ Agentic generative UI event emitted for {tool_name} - emitting RunFinishedEvent and stopping")
                                        yield RunFinishedEvent(
                                            type=EventType.RUN_FINISHED,
                                            thread_id=input_data.thread_id,
                                            run_id=input_data.run_id,
                                        )
                                        return
                                    
                                    # For regular tool results
                                    if isinstance(method_result, str):
                                        tool_result_content = method_result
                                    elif isinstance(method_result, dict):
                                        tool_result_content = json.dumps(method_result)
                                    else:
                                        tool_result_content = json.dumps({"result": str(method_result)})
                                    
                                    logger.info(f"✅ Tool {tool_name} executed successfully, result: {tool_result_content[:200]}")
                            else:
                                logger.error(f"❌ Method {tool_name} not found on agent")
                        except Exception as tool_err:
                            logger.error(f"❌ Error executing tool {tool_name}: {tool_err}", exc_info=True)
                        
                        # Emit tool result
                        if tool_result_content:
                            # Emit ToolCallResultEvent (this is what CopilotKit needs to render the result)
                            # IMPORTANT: We need role="tool" for CopilotKit to match the result to the action
                            # Loop prevention is handled by checking message_history and early return after tool execution
                            tool_result_msg_id = str(uuid.uuid4())
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=tool_call_id,
                                message_id=tool_result_msg_id,
                                content=tool_result_content,
                                role="tool",  # Required for CopilotKit to match result to actionExecutionId
                            )
                            logger.info(f"✅ Tool result emitted for {tool_name}: {tool_result_content[:200]}")
                            # DO NOT emit MessagesSnapshotEvent here - it will replace all messages!
                            # ToolCallResultEvent is sufficient for CopilotKit to render the result
                        else:
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=tool_call_id,
                                message_id=str(uuid.uuid4()),
                                content=json.dumps({"error": f"Tool {tool_name} execution failed"}),
                                role="tool",  # Required for CopilotKit to match result to actionExecutionId
                            )
                            logger.warning(f"⚠️ Tool {tool_name} execution failed - no result content")
                        
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=tool_call_id,
                        )
                        
                        # IMPORTANT: For backend tools, stop here after emitting the result
                        # DO NOT call llm_response() again as it might trigger another tool call, creating a loop
                        # The tool result has been emitted, which is what CopilotKit needs to render it
                        logger.info(f"✅ Backend tool {tool_name} execution complete - emitting RunFinishedEvent and stopping to prevent loop")
                        
                        yield RunFinishedEvent(
                            type=EventType.RUN_FINISHED,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                        return  # IMPORTANT: Return early to prevent loop

                    # Emit text message events only if we have non-tool-call content
                    if content and content.strip():
                        logger.info(f"✅ Emitting regular text message: content_length={len(content)}, preview={content[:100]}")
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant",
                        )
                        message_started = True

                        # Stream content in chunks (ensure delta is never empty)
                        chunk_size = 50
                        for i in range(0, len(content), chunk_size):
                            chunk = content[i:i + chunk_size]
                            if chunk:  # Only emit non-empty chunks
                                yield TextMessageContentEvent(
                                    type=EventType.TEXT_MESSAGE_CONTENT,
                                    message_id=message_id,
                                    delta=chunk,
                                )
                    elif not tool_call_detected:
                        # No content and no tool call - this shouldn't happen, but log it
                        logger.warning(f"⚠️ No content to emit and no tool call detected. response_content length: {len(response_content) if response_content else 0}, tool_call_detected={tool_call_detected}")
                        # Try to emit the response_content as-is if it exists
                        if response_content and response_content.strip():
                            logger.info(f"⚠️ Falling back to emitting response_content directly: {response_content[:200]}")
                            yield TextMessageStartEvent(
                                type=EventType.TEXT_MESSAGE_START,
                                message_id=message_id,
                                role="assistant",
                            )
                            message_started = True
                            chunk_size = 50
                            for i in range(0, len(response_content), chunk_size):
                                chunk = response_content[i:i + chunk_size]
                                if chunk:  # Only emit non-empty chunks
                                    yield TextMessageContentEvent(
                                        type=EventType.TEXT_MESSAGE_CONTENT,
                                        message_id=message_id,
                                        delta=chunk,
                                    )

                # Always emit TextMessageEndEvent if we started a message
                if message_started:
                    yield TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=message_id,
                    )
                    logger.debug(f"✅ TextMessageEndEvent emitted for message_id={message_id}")

            except Exception as e:
                logger.error(f"Error running Langroid agent: {e}", exc_info=True)
                yield RunErrorEvent(
                    type=EventType.RUN_ERROR,
                    message=f"Agent error: {str(e)}",
                    code="LANGROID_ERROR",
                )
                return

            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )

        except Exception as e:
            logger.error(f"Error in Langroid agent run: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
                code="LANGROID_ERROR",
            )

    def _get_agent_instance(self) -> Any:
        """Get agent instance for current thread."""
        # For now, return the agent as-is
        # In future, we might need to clone it per thread
        agent = self._agent
        # Log available handlers for debugging
        if hasattr(agent, "agent") and hasattr(agent.agent, "_backend_tool_handlers"):
            logger.debug(f"Agent has handlers: {list(agent.agent._backend_tool_handlers.keys())}")
        elif hasattr(agent, "_backend_tool_handlers"):
            logger.debug(f"Agent (Task) has handlers: {list(agent._backend_tool_handlers.keys())}")
        return agent

    def _extract_user_message(self, messages: Optional[List[Any]]) -> str:
        """Extract the latest user message from AG-UI messages."""
        if not messages:
            return "Hello"

        # Find the last user message
        for msg in reversed(messages):
            if hasattr(msg, "role") and msg.role == "user":
                if hasattr(msg, "content"):
                    content = msg.content
                    if isinstance(content, str):
                        return content
                    elif isinstance(content, list):
                        text_parts = []
                        for block in content:
                            if isinstance(block, dict) and "text" in block:
                                text_parts.append(block["text"])
                            elif isinstance(block, str):
                                text_parts.append(block)
                        return " ".join(text_parts) if text_parts else "Hello"
                return str(msg)

        return "Hello"

