import uuid
import json
from typing import Optional, List, Any, Union, AsyncGenerator, Generator
from dataclasses import is_dataclass, asdict
from datetime import date, datetime

from langgraph.graph.state import CompiledStateGraph
from langchain.schema import BaseMessage, SystemMessage
from langchain_core.runnables import RunnableConfig, ensure_config
from langchain_core.messages import HumanMessage
from langgraph.types import Command

from .types import (
    State,
    LangGraphPlatformMessage,
    MessagesInProgressRecord,
    SchemaKeys,
    MessageInProgress,
    RunMetadata,
    LangGraphEventTypes,
    CustomEventNames,
    LangGraphReasoning
)
from .utils import (
    agui_messages_to_langchain,
    DEFAULT_SCHEMA_KEYS,
    filter_object_by_schema_keys,
    get_stream_payload_input,
    langchain_messages_to_agui,
    resolve_reasoning_content,
    resolve_message_content,
    camel_to_snake
)

from ag_ui.core import (
    EventType,
    CustomEvent,
    MessagesSnapshotEvent,
    RawEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateDeltaEvent,
    StateSnapshotEvent,
    StepFinishedEvent,
    StepStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    ThinkingTextMessageStartEvent,
    ThinkingTextMessageContentEvent,
    ThinkingTextMessageEndEvent,
    ThinkingStartEvent,
    ThinkingEndEvent,
)
from ag_ui.encoder import EventEncoder

ProcessedEvents = Union[
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    ToolCallStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    StateSnapshotEvent,
    StateDeltaEvent,
    MessagesSnapshotEvent,
    RawEvent,
    CustomEvent,
    RunStartedEvent,
    RunFinishedEvent,
    RunErrorEvent,
    StepStartedEvent,
    StepFinishedEvent,
]

class LangGraphAgent:
    def __init__(self, *, name: str, graph: CompiledStateGraph, description: Optional[str] = None, config:  Union[Optional[RunnableConfig], dict] = None):
        self.name = name
        self.description = description
        self.graph = graph
        self.config = config or {}
        self.messages_in_process: MessagesInProgressRecord = {}
        self.active_run: Optional[RunMetadata] = None
        self.constant_schema_keys = ['messages', 'tools']
        self.active_step = None

    def _dispatch_event(self, event: ProcessedEvents) -> str:
        return event  # Fallback if no encoder

    async def run(self, input: RunAgentInput) -> AsyncGenerator[str, None]:
        forwarded_props = {}
        if hasattr(input, "forwarded_props") and input.forwarded_props:
            forwarded_props = {
                camel_to_snake(k): v for k, v in input.forwarded_props.items()
            }
        async for event_str in self._handle_stream_events(input.copy(update={"forwarded_props": forwarded_props})):
            yield event_str

    async def _handle_stream_events(self, input: RunAgentInput) -> AsyncGenerator[str, None]:
        thread_id = input.thread_id or str(uuid.uuid4())
        INITIAL_ACTIVE_RUN = {
            "id": input.run_id,
            "thread_id": thread_id,
            "thinking_process": None,
            "node_name": None,
        }
        self.active_run = INITIAL_ACTIVE_RUN

        forwarded_props = input.forwarded_props
        node_name_input = forwarded_props.get('node_name', None) if forwarded_props else None

        self.active_run["manually_emitted_state"] = None
        self.active_run["node_name"] = node_name_input
        if self.active_run["node_name"] == "__end__":
            self.active_run["node_name"] = None

        config = ensure_config(self.config.copy() if self.config else {})
        config["configurable"] = {**(config.get('configurable', {})), "thread_id": thread_id}

        agent_state = await self.graph.aget_state(config)
        resume_input = forwarded_props.get('command', {}).get('resume', None)

        if resume_input is None and thread_id and self.active_run.get("node_name") != "__end__" and self.active_run.get("node_name"):
            self.active_run["mode"] = "continue"
        else:
            self.active_run["mode"] = "start"

        prepared_stream_response = await self.prepare_stream(input=input, agent_state=agent_state, config=config)

        yield self._dispatch_event(
            RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=self.active_run["id"])
        )

        # In case of resume (interrupt), re-start resumed step
        if resume_input and self.active_run.get("node_name"):
            for ev in self.start_step(self.active_run.get("node_name")):
                yield ev

        state = prepared_stream_response["state"]
        stream = prepared_stream_response["stream"]
        config = prepared_stream_response["config"]
        events_to_dispatch = prepared_stream_response.get('events_to_dispatch', None)

        if events_to_dispatch is not None and len(events_to_dispatch) > 0:
            for event in events_to_dispatch:
                yield self._dispatch_event(event)
            return

        should_exit = False
        current_graph_state = state
        
        async for event in stream:
            subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs') if input.forwarded_props else False
            is_subgraph_stream = (subgraphs_stream_enabled and (
                event.get("event", "").startswith("events") or 
                event.get("event", "").startswith("values")
            ))
            if event["event"] == "error":
                yield self._dispatch_event(
                    RunErrorEvent(type=EventType.RUN_ERROR, message=event["data"]["message"], raw_event=event)
                )
                break

            current_node_name = event.get("metadata", {}).get("langgraph_node")
            event_type = event.get("event")
            self.active_run["id"] = event.get("run_id")
            exiting_node = False

            if event_type == "on_chain_end" and isinstance(
                    event.get("data", {}).get("output"), dict
            ):
                current_graph_state.update(event["data"]["output"])
                exiting_node = self.active_run["node_name"] == current_node_name

            should_exit = should_exit or (
                    event_type == "on_custom_event" and
                    event["name"] == "exit"
                )

            if current_node_name and current_node_name != self.active_run.get("node_name"):
                for ev in self.start_step(current_node_name):
                    yield ev

            updated_state = self.active_run.get("manually_emitted_state") or current_graph_state
            has_state_diff = updated_state != state
            if exiting_node or (has_state_diff and not self.get_message_in_progress(self.active_run["id"])):
                state = updated_state
                self.active_run["prev_node_name"] = self.active_run["node_name"]
                current_graph_state.update(updated_state)
                yield self._dispatch_event(
                    StateSnapshotEvent(
                        type=EventType.STATE_SNAPSHOT,
                        snapshot=self.get_state_snapshot(state),
                        raw_event=event,
                    )
                )

            yield self._dispatch_event(
                RawEvent(type=EventType.RAW, event=event)
            )

            async for single_event in self._handle_single_event(event, state):
                yield single_event

        state = await self.graph.aget_state(config)

        tasks = state.tasks if len(state.tasks) > 0 else None
        interrupts = tasks[0].interrupts if tasks else []

        writes = state.metadata.get("writes", {}) or {}
        node_name = self.active_run["node_name"] if interrupts else next(iter(writes), None)
        next_nodes = state.next or ()
        is_end_node = len(next_nodes) == 0 and not interrupts

        node_name = "__end__" if is_end_node else node_name

        for interrupt in interrupts:
            yield self._dispatch_event(
                CustomEvent(
                    type=EventType.CUSTOM,
                    name=LangGraphEventTypes.OnInterrupt.value,
                    value=json.dumps(interrupt.value, default=make_json_safe) if not isinstance(interrupt.value, str) else interrupt.value,
                    raw_event=interrupt,
                )
            )

        if self.active_run.get("node_name") != node_name:
            for ev in self.start_step(node_name):
                yield ev

        state_values = state.values if state.values else state
        yield self._dispatch_event(
            StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(state_values))
        )

        yield self._dispatch_event(
            MessagesSnapshotEvent(
                type=EventType.MESSAGES_SNAPSHOT,
                messages=langchain_messages_to_agui(state_values.get("messages", [])),
            )
        )

        yield self.end_step()

        yield self._dispatch_event(
            RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=self.active_run["id"])
        )
        # Reset active run to how it was before the stream started
        self.active_run = INITIAL_ACTIVE_RUN


    async def prepare_stream(self, input: RunAgentInput, agent_state: State, config: RunnableConfig):
        state_input = input.state or {}
        messages = input.messages or []
        tools = input.tools or []
        forwarded_props = input.forwarded_props or {}
        thread_id = input.thread_id

        state_input["messages"] = agent_state.values.get("messages", [])
        self.active_run["current_graph_state"] = agent_state.values.copy()
        langchain_messages = agui_messages_to_langchain(messages)
        state = self.langgraph_default_merge_state(state_input, langchain_messages, tools)
        self.active_run["current_graph_state"].update(state)
        config["configurable"]["thread_id"] = thread_id
        interrupts = agent_state.tasks[0].interrupts if agent_state.tasks and len(agent_state.tasks) > 0 else []
        has_active_interrupts = len(interrupts) > 0
        resume_input = forwarded_props.get('command', {}).get('resume', None)

        self.active_run["schema_keys"] = self.get_schema_keys(config)

        non_system_messages = [msg for msg in langchain_messages if not isinstance(msg, SystemMessage)]
        if len(agent_state.values.get("messages", [])) > len(non_system_messages):
            # Find the last user message by working backwards from the last message
            last_user_message = None
            for i in range(len(langchain_messages) - 1, -1, -1):
                if isinstance(langchain_messages[i], HumanMessage):
                    last_user_message = langchain_messages[i]
                    break

            if last_user_message:
                return await self.prepare_regenerate_stream(
                    input=input,
                    message_checkpoint=last_user_message,
                    config=config
                )

        events_to_dispatch = []
        if has_active_interrupts and not resume_input:
            events_to_dispatch.append(
                RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=self.active_run["id"])
            )

            for interrupt in interrupts:
                events_to_dispatch.append(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name=LangGraphEventTypes.OnInterrupt.value,
                        value=json.dumps(interrupt.value) if not isinstance(interrupt.value, str) else interrupt.value,
                        raw_event=interrupt,
                    )
                )

            events_to_dispatch.append(
                RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=self.active_run["id"])
            )
            return {
                "stream": None,
                "state": None,
                "config": None,
                "events_to_dispatch": events_to_dispatch,
            }

        if self.active_run["mode"] == "continue":
            await self.graph.aupdate_state(config, state, as_node=self.active_run.get("node_name"))

        if resume_input:
            stream_input = Command(resume=resume_input)
        else:
            payload_input = get_stream_payload_input(
                mode=self.active_run["mode"],
                state=state,
                schema_keys=self.active_run["schema_keys"],
            )
            stream_input = {**forwarded_props, **payload_input} if payload_input else None


        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs') if input.forwarded_props else False

        stream = self.graph.astream_events(
            stream_input,
            config=config,
            subgraps=bool(subgraphs_stream_enabled),
            version="v2"
        )

        return {
            "stream": stream,
            "state": state,
            "config": config
        }

    async def prepare_regenerate_stream( # pylint: disable=too-many-arguments
            self,
            input: RunAgentInput,
            message_checkpoint: HumanMessage,
            config: RunnableConfig
    ):
        tools = input.tools or []
        thread_id = input.thread_id

        time_travel_checkpoint = await self.get_checkpoint_before_message(message_checkpoint.id, thread_id)
        if time_travel_checkpoint is None:
            return None

        fork = await self.graph.aupdate_state(
            time_travel_checkpoint.config,
            time_travel_checkpoint.values,
            as_node=time_travel_checkpoint.next[0] if time_travel_checkpoint.next else "__start__"
        )

        stream_input = self.langgraph_default_merge_state(time_travel_checkpoint.values, [message_checkpoint], tools)
        subgraphs_stream_enabled = input.forwarded_props.get('stream_subgraphs') if input.forwarded_props else False
        stream = self.graph.astream_events(
            stream_input,
            fork,
            subgraps=bool(subgraphs_stream_enabled),
            version="v2"
        )

        return {
            "stream": stream,
            "state": time_travel_checkpoint.values,
            "config": config
        }

    def get_message_in_progress(self, run_id: str) -> Optional[MessageInProgress]:
        return self.messages_in_process.get(run_id)

    def set_message_in_progress(self, run_id: str, data: MessageInProgress):
        current_message_in_progress = self.messages_in_process.get(run_id, {})
        self.messages_in_process[run_id] = {
            **current_message_in_progress,
            **data,
        }

    def get_schema_keys(self, config) -> SchemaKeys:
        try:
            input_schema = self.graph.get_input_jsonschema(config)
            output_schema = self.graph.get_output_jsonschema(config)
            config_schema = self.graph.config_schema().schema()

            input_schema_keys = list(input_schema["properties"].keys()) if "properties" in input_schema else []
            output_schema_keys = list(output_schema["properties"].keys()) if "properties" in output_schema else []
            config_schema_keys = list(config_schema["properties"].keys()) if "properties" in config_schema else []

            return {
                "input": [*input_schema_keys, *self.constant_schema_keys],
                "output": [*output_schema_keys, *self.constant_schema_keys],
                "config": config_schema_keys,
            }
        except Exception:
            return {
                "input": self.constant_schema_keys,
                "output": self.constant_schema_keys,
                "config": [],
            }

    def langgraph_default_merge_state(self, state: State, messages: List[BaseMessage], tools: Any) -> State:
        if messages and isinstance(messages[0], SystemMessage):
            messages = messages[1:]

        existing_messages: List[LangGraphPlatformMessage] = state.get("messages", [])
        existing_message_ids = {msg.id for msg in existing_messages}

        new_messages = [msg for msg in messages if msg.id not in existing_message_ids]

        tools_as_dicts = []
        if tools:
            for tool in tools:
                if hasattr(tool, "model_dump"):
                    tools_as_dicts.append(tool.model_dump())
                elif hasattr(tool, "dict"):
                    tools_as_dicts.append(tool.dict())
                else:
                    tools_as_dicts.append(tool)

        return {
            **state,
            "messages": new_messages,
            "tools": [*state.get("tools", []), *tools_as_dicts],
        }

    def get_state_snapshot(self, state: State) -> State:
        schema_keys = self.active_run["schema_keys"]
        if schema_keys and schema_keys.get("output"):
            state = filter_object_by_schema_keys(state, [*DEFAULT_SCHEMA_KEYS, *schema_keys["output"]])
        return state

    async def _handle_single_event(self, event: Any, state: State) -> AsyncGenerator[str, None]:
        event_type = event.get("event")
        if event_type == LangGraphEventTypes.OnChatModelStream:
            should_emit_messages = event["metadata"].get("emit-messages", True)
            should_emit_tool_calls = event["metadata"].get("emit-tool-calls", True)

            if event["data"]["chunk"].response_metadata.get('finish_reason', None):
                return

            current_stream = self.get_message_in_progress(self.active_run["id"])
            has_current_stream = bool(current_stream and current_stream.get("id"))
            tool_call_data = event["data"]["chunk"].tool_call_chunks[0] if event["data"]["chunk"].tool_call_chunks else None
            predict_state_metadata = event["metadata"].get("predict_state", [])
            tool_call_used_to_predict_state = False
            if tool_call_data and tool_call_data.get("name") and predict_state_metadata:
                tool_call_used_to_predict_state = any(
                    predict_tool.get("tool") == tool_call_data["name"]
                    for predict_tool in predict_state_metadata
                )

            is_tool_call_start_event = not has_current_stream and tool_call_data and tool_call_data.get("name")
            is_tool_call_args_event = has_current_stream and current_stream.get("tool_call_id") and tool_call_data and tool_call_data.get("args")
            is_tool_call_end_event = has_current_stream and current_stream.get("tool_call_id") and not tool_call_data

            reasoning_data = resolve_reasoning_content(event["data"]["chunk"]) if event["data"]["chunk"] else None
            message_content = resolve_message_content(event["data"]["chunk"].content) if event["data"]["chunk"] and event["data"]["chunk"].content else None
            is_message_content_event = tool_call_data is None and message_content
            is_message_end_event = has_current_stream and not current_stream.get("tool_call_id") and not is_message_content_event

            if reasoning_data:
                self.handle_thinking_event(reasoning_data)
                return

            if reasoning_data is None and self.active_run.get('thinking_process', None) is not None:
                yield self._dispatch_event(
                    ThinkingTextMessageEndEvent(
                        type=EventType.THINKING_TEXT_MESSAGE_END,
                    )
                )
                yield self._dispatch_event(
                    ThinkingEndEvent(
                        type=EventType.THINKING_END,
                    )
                )
                self.active_run["thinking_process"] = None

            if tool_call_used_to_predict_state:
                yield self._dispatch_event(
                    CustomEvent(
                        type=EventType.CUSTOM,
                        name="PredictState",
                        value=predict_state_metadata,
                        raw_event=event
                    )
                )

            if is_tool_call_end_event:
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=current_stream["tool_call_id"], raw_event=event)
                )
                self.messages_in_process[self.active_run["id"]] = None
                return


            if is_message_end_event:
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=current_stream["id"], raw_event=event)
                )
                self.messages_in_process[self.active_run["id"]] = None
                return

            if is_tool_call_start_event and should_emit_tool_calls:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=tool_call_data["id"],
                        tool_call_name=tool_call_data["name"],
                        parent_message_id=event["data"]["chunk"].id,
                        raw_event=event,
                    )
                )
                self.set_message_in_progress(
                    self.active_run["id"],
                    MessageInProgress(id=event["data"]["chunk"].id, tool_call_id=tool_call_data["id"], tool_call_name=tool_call_data["name"])
                )
                return

            if is_tool_call_args_event and should_emit_tool_calls:
                yield self._dispatch_event(
                    ToolCallArgsEvent(
                        type=EventType.TOOL_CALL_ARGS,
                        tool_call_id=current_stream["tool_call_id"],
                        delta=tool_call_data["args"],
                        raw_event=event
                    )
                )
                return

            if is_message_content_event and should_emit_messages:
                if bool(current_stream and current_stream.get("id")) == False:
                    yield self._dispatch_event(
                        TextMessageStartEvent(
                            type=EventType.TEXT_MESSAGE_START,
                            role="assistant",
                            message_id=event["data"]["chunk"].id,
                            raw_event=event,
                        )
                    )
                    self.set_message_in_progress(
                        self.active_run["id"],
                        MessageInProgress(
                            id=event["data"]["chunk"].id,
                            tool_call_id=None,
                            tool_call_name=None
                        )
                    )
                    current_stream = self.get_message_in_progress(self.active_run["id"])

                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=current_stream["id"],
                        delta=message_content,
                        raw_event=event,
                    )
                )
                return

        elif event_type == LangGraphEventTypes.OnChatModelEnd:
            if self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("tool_call_id"):
                resolved = self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=self.get_message_in_progress(self.active_run["id"])["tool_call_id"], raw_event=event)
                )
                if resolved:
                    self.messages_in_process[self.active_run["id"]] = None
                yield resolved
            elif self.get_message_in_progress(self.active_run["id"]) and self.get_message_in_progress(self.active_run["id"]).get("id"):
                resolved = self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=self.get_message_in_progress(self.active_run["id"])["id"], raw_event=event)
                )
                if resolved:
                    self.messages_in_process[self.active_run["id"]] = None
                yield resolved

        elif event_type == LangGraphEventTypes.OnCustomEvent:
            if event["name"] == CustomEventNames.ManuallyEmitMessage:
                yield self._dispatch_event(
                    TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, role="assistant", message_id=event["data"]["message_id"], raw_event=event)
                )
                yield self._dispatch_event(
                    TextMessageContentEvent(
                        type=EventType.TEXT_MESSAGE_CONTENT,
                        message_id=event["data"]["message_id"],
                        delta=event["data"]["message"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=event["data"]["message_id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitToolCall:
                yield self._dispatch_event(
                    ToolCallStartEvent(
                        type=EventType.TOOL_CALL_START,
                        tool_call_id=event["data"]["id"],
                        tool_call_name=event["data"]["name"],
                        parent_message_id=event["data"]["id"],
                        raw_event=event,
                    )
                )
                yield self._dispatch_event(
                    ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=event["data"]["id"], delta=event["data"]["args"], raw_event=event)
                )
                yield self._dispatch_event(
                    ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=event["data"]["id"], raw_event=event)
                )

            elif event["name"] == CustomEventNames.ManuallyEmitState:
                self.active_run["manually_emitted_state"] = event["data"]
                yield self._dispatch_event(
                    StateSnapshotEvent(type=EventType.STATE_SNAPSHOT, snapshot=self.get_state_snapshot(self.active_run["manually_emitted_state"]), raw_event=event)
                )
            
            yield self._dispatch_event(
                CustomEvent(type=EventType.CUSTOM, name=event["name"], value=event["data"], raw_event=event)
            )

    def handle_thinking_event(self, reasoning_data: LangGraphReasoning) -> Generator[str, Any, str | None]:
        if not reasoning_data or "type" not in reasoning_data or "text" not in reasoning_data:
            return ""

        thinking_step_index = reasoning_data.get("index")

        if (self.active_run.get("thinking_process") and
                self.active_run["thinking_process"].get("index") and
                self.active_run["thinking_process"]["index"] != thinking_step_index):

            if self.active_run["thinking_process"].get("type"):
                yield self._dispatch_event(
                    ThinkingTextMessageEndEvent(
                        type=EventType.THINKING_TEXT_MESSAGE_END,
                    )
                )
            yield self._dispatch_event(
                ThinkingEndEvent(
                    type=EventType.THINKING_END,
                )
            )
            self.active_run["thinking_process"] = None

        if not self.active_run.get("thinking_process"):
            yield self._dispatch_event(
                ThinkingStartEvent(
                    type=EventType.THINKING_START,
                )
            )
            self.active_run["thinking_process"] = {
                "index": thinking_step_index
            }

        if self.active_run["thinking_process"].get("type") != reasoning_data["type"]:
            yield self._dispatch_event(
                ThinkingTextMessageStartEvent(
                    type=EventType.THINKING_TEXT_MESSAGE_START,
                )
            )
            self.active_run["thinking_process"]["type"] = reasoning_data["type"]

        if self.active_run["thinking_process"].get("type"):
            yield self._dispatch_event(
                ThinkingTextMessageContentEvent(
                    type=EventType.THINKING_TEXT_MESSAGE_CONTENT,
                    delta=reasoning_data["text"]
                )
            )

    async def get_checkpoint_before_message(self, message_id: str, thread_id: str):
        if not thread_id:
            raise ValueError("Missing thread_id in config")

        history_list = []
        async for snapshot in self.graph.aget_state_history({"configurable": {"thread_id": thread_id}}):
            history_list.append(snapshot)

        history_list.reverse()
        for idx, snapshot in enumerate(history_list):
            messages = snapshot.values.get("messages", [])
            if any(getattr(m, "id", None) == message_id for m in messages):
                if idx == 0:
                    # No snapshot before this
                    # Return synthetic "empty before" version
                    empty_snapshot = snapshot
                    empty_snapshot.values["messages"] = []
                    return empty_snapshot

                snapshot_values_without_messages = snapshot.values.copy()
                del snapshot_values_without_messages["messages"]
                checkpoint = history_list[idx - 1]

                merged_values = {**checkpoint.values, **snapshot_values_without_messages}
                checkpoint = checkpoint._replace(values=merged_values)

                return checkpoint

        raise ValueError("Message ID not found in history")

    def start_step(self, step_name: str):
        if self.active_step:
            yield self.end_step()

        yield self._dispatch_event(
            StepStartedEvent(
                type=EventType.STEP_STARTED,
                step_name=step_name
            )
        )
        self.active_run["node_name"] = step_name
        self.active_step = step_name

    def end_step(self):
        if self.active_step is None:
            raise ValueError("No active step to end")

        dispatch = self._dispatch_event(
            StepFinishedEvent(
                type=EventType.STEP_FINISHED,
                step_name=self.active_run["node_name"] or self.active_step
            )
        )

        self.active_run["node_name"] = None
        self.active_step = None
        return dispatch

def make_json_safe(o):
    if is_dataclass(o):          # dataclasses like Flight(...)
        return asdict(o)
    if hasattr(o, "model_dump"): # pydantic v2
        return o.model_dump()
    if hasattr(o, "dict"):       # pydantic v1
        return o.dict()
    if hasattr(o, "__dict__"):   # plain objects
        return vars(o)
    if isinstance(o, (datetime, date)):
        return o.isoformat()
    return str(o)                # last resort
