package com.agui.spring.ai;

import org.springframework.ai.chat.model.ToolContext;
import org.springframework.ai.tool.ToolCallback;

import org.springframework.ai.tool.definition.ToolDefinition;
import org.springframework.lang.Nullable;

import java.util.function.Consumer;

public class AgUiFunctionToolCallback implements ToolCallback {

    private final ToolCallback toolCallback;

    private final Consumer<AgUiToolCallbackParams> callback;

    public AgUiFunctionToolCallback(final ToolCallback toolCallback, final Consumer<AgUiToolCallbackParams> callback) {
        this.toolCallback = toolCallback;

        this.callback = callback;
    }

    @Override
    public ToolDefinition getToolDefinition() {
        return toolCallback.getToolDefinition();
    }

    @Override
    public String call(String toolInput) {
        return call(toolInput, null);
    }

    public String call(String toolInput, @Nullable ToolContext toolContext) {
        var result = this.toolCallback.call(toolInput, toolContext);

        this.callback.accept(new AgUiToolCallbackParams(result, toolInput));

        return result;
    }

}