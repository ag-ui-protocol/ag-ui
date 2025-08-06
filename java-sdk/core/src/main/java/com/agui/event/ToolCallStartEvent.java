package com.agui.event;

import com.agui.types.EventType;

public class ToolCallStartEvent extends BaseEvent {

    public ToolCallStartEvent() {
        super(EventType.TOOL_CALL_START);
    }
}
