package com.agui.event;

import com.agui.types.EventType;
import com.fasterxml.jackson.annotation.JsonIgnore;
import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;

@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,
    property = "type"
)
@JsonSubTypes({
    @JsonSubTypes.Type(value = CustomEvent.class, name = "CUSTOM"),
    @JsonSubTypes.Type(value = MessagesSnapshotEvent.class, name = "MESSAGES_SNAPSHOT"),
    @JsonSubTypes.Type(value = RawEvent.class, name = "RAW"),
    @JsonSubTypes.Type(value = RunErrorEvent.class, name = "RUN_ERROR"),
    @JsonSubTypes.Type(value = RunFinishedEvent.class, name = "RUN_FINISHED"),
    @JsonSubTypes.Type(value = RunStartedEvent.class, name = "RUN_STARTED"),
    @JsonSubTypes.Type(value = StateDeltaEvent.class, name = "STATE_DELTA"),
    @JsonSubTypes.Type(value = StateSnapshotEvent.class, name = "STATE_SNAPSHOT"),
    @JsonSubTypes.Type(value = StepFinishedEvent.class, name = "STEP_FINISHED"),
    @JsonSubTypes.Type(value = StepStartedEvent.class, name = "STEP_STARTED"),
    @JsonSubTypes.Type(value = TextMessageChunkEvent.class, name = "TEXT_MESSAGE_CHUNK"),
    @JsonSubTypes.Type(value = TextMessageContentEvent.class, name = "TEXT_MESSAGE_CONTENT"),
    @JsonSubTypes.Type(value = TextMessageEndEvent.class, name = "TEXT_MESSAGE_END"),
    @JsonSubTypes.Type(value = TextMessageStartEvent.class, name = "TEXT_MESSAGE_START"),
    @JsonSubTypes.Type(value = ThinkingEndEvent.class, name = "THINKING_END"),
    @JsonSubTypes.Type(value = ThinkingStartEvent.class, name = "THINKING_START"),
    @JsonSubTypes.Type(value = ThinkingTextMessageContentEvent.class, name = "THINKING_TEXT_MESSAGE_CONTENT"),
    @JsonSubTypes.Type(value = ThinkingTextMessageEndEvent.class, name = "THINKING_TEXT_MESSAGE_END"),
    @JsonSubTypes.Type(value = ThinkingTextMessageStartEvent.class, name = "THINKING_TEXT_MESSAGE_START"),
    @JsonSubTypes.Type(value = ToolCallArgsEvent.class, name = "TOOL_CALL_ARGS"),
    @JsonSubTypes.Type(value = ToolCallChunkEvent.class, name = "TOOL_CALL_CHUNK"),
    @JsonSubTypes.Type(value = ToolCallEndEvent.class, name = "TOOL_CALL_END"),
    @JsonSubTypes.Type(value = ToolCallResultEvent.class, name = "TOOL_CALL_RESULT"),
    @JsonSubTypes.Type(value = ToolCallStartEvent.class, name = "TOOL_CALL_START")
})
public class BaseEvent {

    private final EventType type;

    private int timestamp;

    private Object rawEvent;

    public BaseEvent(final EventType type) {
        this.type = type;
    }

    @JsonIgnore
    public EventType getType() {
        return this.type;
    }

    public void setTimestamp(final int timestamp) {
        this.timestamp = timestamp;
    }

    public int getTimestamp() {
        return this.timestamp;
    }

    public void setRawEvent(final Object rawEvent) {
        this.rawEvent = rawEvent;
    }

    public Object getRawEvent() {
        return this.rawEvent;
    }
}

