package com.agui.spring.ai;

import com.agui.core.event.BaseEvent;
import com.agui.core.event.ToolCallArgsEvent;
import com.agui.core.event.ToolCallEndEvent;
import com.agui.core.event.ToolCallStartEvent;
import com.agui.core.tool.Tool;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.ai.tool.ToolCallback;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Consumer;

import static java.util.Collections.emptyList;
import static java.util.Collections.emptyMap;
import static org.assertj.core.api.Assertions.assertThat;

class ToolMapperTest {

    private ToolMapper toolMapper;

    @BeforeEach
    void setUp() {
        toolMapper = new ToolMapper();
    }

    @Test
    void shouldMapToolToSpringToolCallback() {
        // Given
        var toolName = "get_weather";
        var toolDescription = "Get current weather for a location";
        var parameters = new Tool.ToolParameters("object", Map.of(
            "location",
                new Tool.ToolProperty("string", "The location")
        ), emptyList());

        Tool tool = new Tool(toolName, toolDescription, parameters);

        String messageId = UUID.randomUUID().toString();

        // When
        ToolCallback toolCallback = toolMapper.toSpringTool(tool, messageId, new Consumer<BaseEvent>() {
            @Override
            public void accept(BaseEvent baseEvent) {

            }
        });

        // Then
        assertThat(toolCallback).isNotNull();
        assertThat(toolCallback.getToolDefinition().name()).isEqualTo(toolName);
        assertThat(toolCallback.getToolDefinition().description()).isEqualTo(toolDescription);

        String inputSchema = toolCallback.getToolDefinition().inputSchema();
        assertThat(inputSchema).contains("\"type\":\"object\"");
        assertThat(inputSchema).contains("\"location\"");
    }

    @Test
    void shouldEmitCorrectEventsWhenToolIsCalled() {
        // Given
        Tool tool = new Tool("test_tool", "Test tool", new Tool.ToolParameters("object", emptyMap(), emptyList()));

        String messageId = UUID.randomUUID().toString();
        String toolInput = "{\"param\": \"value\"}";

        List<BaseEvent> capturedEvents = new ArrayList<>();
        Consumer<BaseEvent> eventCaptor = capturedEvents::add;

        ToolCallback toolCallback = toolMapper.toSpringTool(tool, messageId, eventCaptor);

        // When
        String result = toolCallback.call(toolInput);

        // Then
        assertThat(result).isEmpty();
        assertThat(capturedEvents).hasSize(3);

        // Verify ToolCallStartEvent
        assertThat(capturedEvents.get(0)).isInstanceOf(ToolCallStartEvent.class);
        ToolCallStartEvent startEvent = (ToolCallStartEvent) capturedEvents.get(0);
        assertThat(startEvent.getParentMessageId()).isEqualTo(messageId);
        assertThat(startEvent.getToolCallName()).isEqualTo("test_tool");
        assertThat(startEvent.getToolCallId()).isNotNull();

        // Verify ToolCallArgsEvent
        assertThat(capturedEvents.get(1)).isInstanceOf(ToolCallArgsEvent.class);
        ToolCallArgsEvent argsEvent = (ToolCallArgsEvent) capturedEvents.get(1);
        assertThat(argsEvent.getDelta()).isEqualTo(toolInput);
        assertThat(argsEvent.getToolCallId()).isEqualTo(startEvent.getToolCallId());

        // Verify ToolCallEndEvent
        assertThat(capturedEvents.get(2)).isInstanceOf(ToolCallEndEvent.class);
        ToolCallEndEvent endEvent = (ToolCallEndEvent) capturedEvents.get(2);
        assertThat(endEvent.getToolCallId()).isEqualTo(startEvent.getToolCallId());
    }

}