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

            try:
                actual_agent = langroid_agent
                task = None
                if hasattr(langroid_agent, "agent"):
                    task = langroid_agent
                    actual_agent = langroid_agent.agent
                
                if not hasattr(actual_agent, "llm_response"):
                    raise ValueError("Agent must be a ChatAgent or Task with a ChatAgent")
                
                tool_executed_this_run = False
                max_iterations = 20
                iteration_count = 0
                
                llm_response_input = "" if has_pending_tool_result else user_message
                llm_response = actual_agent.llm_response(llm_response_input)
                
                if llm_response is None:
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message="Agent returned None",
                        code="LANGROID_ERROR",
                    )
                    return

                tool_call_detected = False
                tool_call_message = None
                parsed_tool_call_from_content = None
                response_content = ""
                if hasattr(llm_response, "content"):
                    response_content = str(llm_response.content) if llm_response.content else ""
                elif isinstance(llm_response, str):
                    response_content = llm_response
                else:
                    response_content = str(llm_response)
                
                if has_pending_tool_result:
                    logger.info("⏭️ Skipping tool detection - last message is a tool result, will only generate text response")
                else:
                    if response_content:
                        content_stripped = response_content.strip()
                        # Check for tool call patterns: ```json\n{...} or {...} with "request" field
                        if "```json" in content_stripped or ('{"request"' in content_stripped or '"request"' in content_stripped):
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
                                            parsed_tool_call_from_content = potential_tool_call
                                            logger.info(f"✅ Tool call detected in response content (early check): {parsed_tool_call_from_content}")
                                    except json.JSONDecodeError:
                                        pass
                    
                    if hasattr(llm_response, "tool_calls") and llm_response.tool_calls:
                        logger.info(f"✅ Tool calls found in llm_response.tool_calls: {llm_response.tool_calls}")
                    
                    if hasattr(actual_agent, "message_history"):
                        history = actual_agent.message_history
                        if history:
                            last_msg = history[-1] if history else None
                            if last_msg:
                                last_msg_str = str(last_msg).lower()
                                last_msg_type = type(last_msg).__name__
                                if ("temperature" in last_msg_str and "conditions" in last_msg_str) or \
                                   ("chart_type" in last_msg_str) or \
                                   (hasattr(last_msg, "content") and isinstance(last_msg.content, str) and 
                                    ("temperature" in last_msg.content.lower() or "chart_type" in last_msg.content.lower())):
                                    logger.info(f"⏭️ Last message in history appears to be a tool result (type={last_msg_type}) - skipping tool detection to prevent loop")
                                    tool_call_detected = False
                                else:
                                    for msg in reversed(history[-10:]):
                                        if hasattr(msg, "request") and hasattr(msg, "purpose"):
                                            tool_call_detected = True
                                            tool_call_message = msg
                                            logger.info(f"✅ Tool call detected in message_history: request={msg.request}")
                                            break
                                        elif "Tool" in type(msg).__name__ or "tool" in type(msg).__name__.lower():
                                            if hasattr(msg, "request"):
                                                tool_call_detected = True
                                                tool_call_message = msg
                                                logger.info(f"✅ Tool call detected via type check: {msg.request}")
                                                break
                    else:
                        logger.warning("Agent does not have message_history attribute")
                    
                    if not tool_call_detected and parsed_tool_call_from_content:
                        tool_call_detected = True
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

                if tool_call_detected and tool_call_message:
                    if response_content:
                        logger.info(f"🔍 Tool call detected - clearing placeholder text: {response_content[:100]}")
                        response_content = ""
                    
                    tool_name = tool_call_message.request
                    tool_args = {}
                    for field_name, field_value in tool_call_message.__dict__.items():
                        if field_name not in ["request", "purpose"]:
                            tool_args[field_name] = field_value
                    
                    tool_already_executed = False
                    if hasattr(actual_agent, "message_history") and actual_agent.message_history:
                        history = actual_agent.message_history
                        for msg in reversed(history[-5:]):
                            msg_content = str(msg) if hasattr(msg, "__str__") else ""
                            if tool_name == "get_weather" and ("temperature" in msg_content.lower() and tool_args.get("location", "").lower() in msg_content.lower()):
                                tool_already_executed = True
                                logger.warning(f"⚠️ Tool {tool_name} appears to have already been executed (found result in message_history) - skipping to prevent loop")
                                break
                            elif tool_name == "render_chart" and ("chart_type" in msg_content.lower() or "rendered" in msg_content.lower()):
                                tool_already_executed = True
                                logger.warning(f"⚠️ Tool {tool_name} appears to have already been executed (found result in message_history) - skipping to prevent loop")
                                break
                    
                    if tool_already_executed:
                        logger.info(f"⏭️ Tool {tool_name} already executed - generating text response instead")
                        tool_call_detected = False
                    else:
                        is_frontend_tool = tool_name in frontend_tool_names
                        
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
                        
                        if is_frontend_tool:
                            logger.info(f"✅ Frontend tool detected: {tool_name} - emitting events")
                            args_str = json.dumps(tool_args)
                            
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
                        
                        else:
                            yield ToolCallStartEvent(
                                type=EventType.TOOL_CALL_START,
                                tool_call_id=tool_call_id,
                                tool_call_name=tool_name,
                                parent_message_id=message_id,
                            )
                            
                            args_str = json.dumps(tool_args)
                            yield ToolCallArgsEvent(
                                type=EventType.TOOL_CALL_ARGS,
                                tool_call_id=tool_call_id,
                                delta=args_str,
                            )
                            
                            if self.config:
                                tool_behaviors = self.config.get("tool_behaviors", {}) if isinstance(self.config, dict) else getattr(self.config, "tool_behaviors", {})
                                behavior = tool_behaviors.get(tool_name) if isinstance(tool_behaviors, dict) else None
                                
                                if behavior and isinstance(behavior, ToolBehavior) and behavior.state_from_args:
                                    try:
                                        import inspect
                                        
                                        tool_call_context = ToolCallContext(
                                            input_data=input_data,
                                            tool_name=tool_name,
                                            tool_call_id=tool_call_id,
                                            tool_input=tool_call_message,
                                            args_str=args_str,
                                        )
                                        
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
                            
                            logger.info(f"Executing backend tool method: {tool_name}")
                            tool_result_content = None
                            
                            try:
                                if hasattr(actual_agent, tool_name):
                                    tool_method = getattr(actual_agent, tool_name)
                                    if callable(tool_method):
                                        try:
                                            logger.info(f"✅ Executing tool method {tool_name} on {type(actual_agent).__name__}")
                                            method_result = tool_method(tool_call_message)
                                            
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
                                    if task is not None and hasattr(task, "agent"):
                                        task_agent = task.agent
                                        if hasattr(task_agent, tool_name):
                                            tool_method = getattr(task_agent, tool_name)
                                            if callable(tool_method):
                                                try:
                                                    logger.info(f"✅ Found method on task.agent, executing {tool_name}")
                                                    method_result = tool_method(tool_call_message)
                                                    
                                                    if isinstance(method_result, (StateSnapshotEvent, StateDeltaEvent)):
                                                        logger.info(f"✅ Tool {tool_name} returned AG-UI event via task.agent: {type(method_result).__name__}")
                                                        yield method_result
                                                        yield ToolCallEndEvent(
                                                            type=EventType.TOOL_CALL_END,
                                                            tool_call_id=tool_call_id,
                                                        )
                                                        logger.info(f"✅ Agentic generative UI event emitted for {tool_name} - emitting RunFinishedEvent and stopping")
                                                        yield RunFinishedEvent(
                                                            type=EventType.RUN_FINISHED,
                                                            thread_id=input_data.thread_id,
                                                            run_id=input_data.run_id,
                                                        )
                                                        return
                                                    
                                                    if isinstance(method_result, str):
                                                        tool_result_content = method_result
                                                    elif isinstance(method_result, dict):
                                                        tool_result_content = json.dumps(method_result)
                                                    else:
                                                        tool_result_content = json.dumps({"result": str(method_result)})
                                                    logger.info(f"✅ Tool executed via task.agent: {tool_result_content[:200]}")
                                                except Exception as task_err:
                                                    logger.error(f"❌ Error executing via task.agent: {task_err}", exc_info=True)
                                
                                if tool_result_content:
                                    logger.info(f"✅ Emitting tool result events for {tool_name} with content length: {len(tool_result_content)}")
                                    
                                    yield ToolCallResultEvent(
                                        type=EventType.TOOL_CALL_RESULT,
                                        tool_call_id=tool_call_id,
                                        message_id=str(uuid.uuid4()),
                                        content=tool_result_content,
                                        role="tool",
                                    )
                                    
                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_call_id,
                                    )
                                    
                                    handler_method_name = f"_handle_{tool_name}_result"
                                    if hasattr(actual_agent, handler_method_name):
                                        handler_method = getattr(actual_agent, handler_method_name)
                                        if callable(handler_method):
                                            try:
                                                import inspect
                                                if inspect.isasyncgenfunction(handler_method):
                                                    logger.info(f"✅ Found async generator handler {handler_method_name} for {tool_name} - yielding state events")
                                                    async_gen = handler_method(result_data if result_data else {})
                                                    async for state_event in async_gen:
                                                        if state_event is not None:
                                                            logger.info(f"✅ Yielding state event from handler: {type(state_event).__name__}")
                                                            yield state_event
                                                elif inspect.iscoroutinefunction(handler_method):
                                                    logger.info(f"✅ Found coroutine handler {handler_method_name} for {tool_name}")
                                                    state_event = await handler_method(result_data if result_data else {})
                                                    if state_event is not None:
                                                        logger.info(f"✅ Yielding state event from handler: {type(state_event).__name__}")
                                                        yield state_event
                                            except Exception as handler_err:
                                                logger.warning(f"Handler {handler_method_name} failed for {tool_name}: {handler_err}", exc_info=True)
                                else:
                                    logger.error(f"❌ Could not execute tool {tool_name} - tool_result_content is None after execution attempt")
                                    yield ToolCallResultEvent(
                                        type=EventType.TOOL_CALL_RESULT,
                                        tool_call_id=tool_call_id,
                                        message_id=str(uuid.uuid4()),
                                        content=json.dumps({"error": f"Tool {tool_name} execution failed - no result generated", "tool": tool_name}),
                                        role="tool",
                                    )
                                    yield ToolCallEndEvent(
                                        type=EventType.TOOL_CALL_END,
                                        tool_call_id=tool_call_id,
                                    )
                                
                                has_handler = hasattr(actual_agent, f"_handle_{tool_name}_result")
                                if has_handler:
                                    handler_method = getattr(actual_agent, f"_handle_{tool_name}_result", None)
                                    has_handler = handler_method and callable(handler_method)
                                
                                if has_handler:
                                    logger.info(f"✅ Agentic generative UI tool {tool_name} - handler completed, all state events emitted, finishing run")
                                    yield RunFinishedEvent(
                                        type=EventType.RUN_FINISHED,
                                        thread_id=input_data.thread_id,
                                        run_id=input_data.run_id,
                                    )
                                    return
                                
                                logger.info(f"✅ Backend tool {tool_name} execution complete - generating text response from tool result")
                                
                                try:
                                    response_text = None
                                    
                                    if tool_name == "generate_recipe" and tool_args.get("recipe"):
                                        recipe_data = tool_args.get("recipe")
                                        if isinstance(recipe_data, dict):
                                            recipe_title = recipe_data.get("title", "recipe")
                                            has_ingredients = recipe_data.get("ingredients") and len(recipe_data.get("ingredients", [])) > 0
                                            has_instructions = recipe_data.get("instructions") and len(recipe_data.get("instructions", [])) > 0
                                            
                                            if has_ingredients and has_instructions:
                                                response_text = f"I created a complete {recipe_title.lower()} recipe based on the existing ingredients and instructions."
                                            elif has_ingredients:
                                                response_text = f"I created a complete {recipe_title.lower()} recipe based on the existing ingredients."
                                            elif has_instructions:
                                                response_text = f"I created a complete {recipe_title.lower()} recipe based on the existing instructions."
                                            else:
                                                response_text = f"I created a complete {recipe_title.lower()} recipe."
                                            logger.info(f"✅ Generated conversational response for generate_recipe: {response_text}")
                                        else:
                                            response_text = f"I've successfully created the recipe."
                                    elif result_data and isinstance(result_data, dict):
                                        if tool_name == "get_weather":
                                            location = result_data.get("location", "the location")
                                            temp = result_data.get("temperature", "N/A")
                                            conditions = result_data.get("conditions", "unknown")
                                            humidity = result_data.get("humidity", "N/A")
                                            wind = result_data.get("wind_speed", "N/A")
                                            feels_like = result_data.get("feels_like", "N/A")
                                            
                                            response_text = f"The current weather in {location} is {temp}°F with {conditions} conditions. The wind speed is {wind} mph, and the humidity level is at {humidity}%. It feels like {feels_like}°F."
                                        elif tool_name == "render_chart":
                                            chart_type = result_data.get("chart_type", "chart")
                                            status = result_data.get("status", "completed")
                                            message = result_data.get("message", f"{chart_type} chart has been rendered")
                                            response_text = f"{message}."
                                        else:
                                            response_text = f"I've successfully executed the {tool_name} tool. Here's the result: {json.dumps(result_data, indent=2)}"
                                    else:
                                        response_text = f"I've successfully executed the {tool_name} tool."
                                    
                                    if response_text:
                                        response_message_id = str(uuid.uuid4())
                                        yield TextMessageStartEvent(
                                            type=EventType.TEXT_MESSAGE_START,
                                            message_id=response_message_id,
                                            role="assistant",
                                        )
                                        
                                        chunk_size = 50
                                        for i in range(0, len(response_text), chunk_size):
                                            chunk = response_text[i:i+chunk_size]
                                            yield TextMessageContentEvent(
                                                type=EventType.TEXT_MESSAGE_CONTENT,
                                                message_id=response_message_id,
                                                delta=chunk,
                                            )
                                        
                                        yield TextMessageEndEvent(
                                            type=EventType.TEXT_MESSAGE_END,
                                            message_id=response_message_id,
                                        )
                                        logger.info(f"✅ Text response generated from tool result: {response_text[:100]}")
                                except Exception as text_err:
                                    logger.warning(f"Failed to generate text response from tool result: {text_err}", exc_info=True)
                                
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
                                    role="tool",
                                )
                                yield ToolCallEndEvent(
                                    type=EventType.TOOL_CALL_END,
                                    tool_call_id=tool_call_id,
                                )
                                logger.info(f"✅ Backend tool {tool_name} execution failed - emitting RunFinishedEvent and stopping to prevent loop")
                                yield RunFinishedEvent(
                                    type=EventType.RUN_FINISHED,
                                    thread_id=input_data.thread_id,
                                    run_id=input_data.run_id,
                                )
                                return
                
                else:
                    content = response_content if response_content else ""
                    parsed_tool_call = None
                    
                    if parsed_tool_call_from_content:
                        parsed_tool_call = parsed_tool_call_from_content
                        logger.info(f"✅ Using tool call from early content check (not in message_history): {parsed_tool_call}")
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
                                    text_before = content_stripped[:json_start].strip()
                                    text_after = content_stripped[json_end:].strip()
                                    remaining_text = " ".join(filter(None, [text_before, text_after])).strip()
                                    content = remaining_text
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
                                        text_before = content_stripped[:json_start].strip()
                                        text_after = content_stripped[json_end:].strip()
                                        remaining_text = " ".join(filter(None, [text_before, text_after])).strip()
                                        content = remaining_text
                                except json.JSONDecodeError:
                                    pass

                    if parsed_tool_call:
                        tool_name = parsed_tool_call.get("request")
                        tool_args = {k: v for k, v in parsed_tool_call.items() if k != "request"}
                        
                        is_frontend_tool = tool_name in frontend_tool_names if tool_name else False
                        
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
                        
                        if is_frontend_tool:
                            logger.info(f"✅ Frontend tool detected: {tool_name} - emitting events")
                            content = ""
                            args_str = json.dumps(tool_args)
                            
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
                        
                        tool_result_content = None
                        try:
                            if hasattr(actual_agent, tool_name):
                                tool_method = getattr(actual_agent, tool_name)
                                if callable(tool_method):
                                    class ParsedToolMessage:
                                        def __init__(self, request, **kwargs):
                                            self.request = request
                                            for k, v in kwargs.items():
                                                setattr(self, k, v)
                                    
                                    parsed_tool_msg = ParsedToolMessage(request=tool_name, **tool_args)
                                    method_result = tool_method(parsed_tool_msg)
                                    
                                    if isinstance(method_result, (StateSnapshotEvent, StateDeltaEvent)):
                                        logger.info(f"✅ Tool {tool_name} returned AG-UI event (from parsed content): {type(method_result).__name__}")
                                        yield method_result
                                        yield ToolCallEndEvent(
                                            type=EventType.TOOL_CALL_END,
                                            tool_call_id=tool_call_id,
                                        )
                                        logger.info(f"✅ Agentic generative UI event emitted for {tool_name} - emitting RunFinishedEvent and stopping")
                                        yield RunFinishedEvent(
                                            type=EventType.RUN_FINISHED,
                                            thread_id=input_data.thread_id,
                                            run_id=input_data.run_id,
                                        )
                                        return
                                    
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
                        
                        if tool_result_content:
                            tool_result_msg_id = str(uuid.uuid4())
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=tool_call_id,
                                message_id=tool_result_msg_id,
                                content=tool_result_content,
                                role="tool",
                            )
                            logger.info(f"✅ Tool result emitted for {tool_name}: {tool_result_content[:200]}")
                        else:
                            yield ToolCallResultEvent(
                                type=EventType.TOOL_CALL_RESULT,
                                tool_call_id=tool_call_id,
                                message_id=str(uuid.uuid4()),
                                content=json.dumps({"error": f"Tool {tool_name} execution failed"}),
                                role="tool",
                            )
                            logger.warning(f"⚠️ Tool {tool_name} execution failed - no result content")
                        
                        yield ToolCallEndEvent(
                            type=EventType.TOOL_CALL_END,
                            tool_call_id=tool_call_id,
                        )
                        
                        logger.info(f"✅ Backend tool {tool_name} execution complete - emitting RunFinishedEvent and stopping to prevent loop")
                        yield RunFinishedEvent(
                            type=EventType.RUN_FINISHED,
                            thread_id=input_data.thread_id,
                            run_id=input_data.run_id,
                        )
                        return

                    if content and content.strip():
                        logger.info(f"✅ Emitting regular text message: content_length={len(content)}, preview={content[:100]}")
                        yield TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            message_id=message_id,
                            role="assistant",
                        )
                        message_started = True

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
                        logger.warning(f"⚠️ No content to emit and no tool call detected. response_content length: {len(response_content) if response_content else 0}, tool_call_detected={tool_call_detected}")
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

                if message_started:
                    yield TextMessageEndEvent(
                        type=EventType.TEXT_MESSAGE_END,
                        message_id=message_id,
                    )

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
        return self._agent

    def _extract_user_message(self, messages: Optional[List[Any]]) -> str:
        """Extract the latest user message from AG-UI messages."""
        if not messages:
            return "Hello"

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

