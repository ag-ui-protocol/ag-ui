package com.agui.event;

import com.agui.types.EventType;

public class TextMessageChunkEvent extends BaseEvent {

    public TextMessageChunkEvent() {
        super(EventType.TEXT_MESSAGE_CHUNK);
    }
}
