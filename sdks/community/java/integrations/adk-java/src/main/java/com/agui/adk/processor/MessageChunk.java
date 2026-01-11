package com.agui.adk.processor;

import com.agui.core.message.BaseMessage;

import java.util.List;

public record MessageChunk(List<BaseMessage> toolMessages, List<BaseMessage> userSystemMessages) {
    public boolean isToolSubmission() {
        return !toolMessages.isEmpty();
    }

    public static MessageChunk fromUserSystemChunk(List<BaseMessage> userSystemChunk) {
        return new MessageChunk(List.of(), userSystemChunk);
    }
}
