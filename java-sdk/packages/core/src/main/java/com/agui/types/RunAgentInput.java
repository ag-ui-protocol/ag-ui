package com.agui.types;

import com.agui.message.BaseMessage;

import java.util.List;

public record RunAgentInput(
    String threadId,
    String runId,
    Object state,
    List<BaseMessage> messages,
    List<Tool> tools,
    List<Context> context,
    Object forwardedProps
) { }

