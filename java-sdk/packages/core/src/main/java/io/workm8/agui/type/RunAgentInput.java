package io.workm8.agui.type;

import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.tool.Tool;

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

