package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.google.adk.events.Event;
import com.agui.core.event.TextMessageEndEvent;
import com.agui.core.event.ToolCallArgsEvent;
import com.agui.core.event.ToolCallEndEvent;
import com.agui.core.event.ToolCallStartEvent;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.Mockito.when;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.mockito.ArgumentMatchers.anyString;

@ExtendWith(MockitoExtension.class)
class ToolCallRequestStepTest {

    private ToolCallRequestStep translationStep;

    @Mock
    private Event event;
    @Mock
    private Content content;
    @Mock
    private TranslationContext context;
    @Mock
    private Part part;
    @Mock
    private FunctionCall functionCall;

    @BeforeEach
    void setUp() {
        translationStep = ToolCallRequestStep.INSTANCE;
    }
    
    private void mockFunctionCall(String id, String name, Optional<Map<String, Object>> args) {
        when(functionCall.id()).thenReturn(Optional.of(id));
        when(functionCall.name()).thenReturn(Optional.of(name));
        when(functionCall.args()).thenReturn(args);
    }

    @Test
    void shouldReturnEmpty_whenNoFunctionCallsArePresent() {
        // Arrange
        when(event.content()).thenReturn(Optional.of(content));
        when(content.parts()).thenReturn(Optional.of(List.of()));

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldEmitToolCallEvents_whenOneFunctionCallIsPresent() {
        // Arrange
        String toolCallId = "tool-call-id-456";
        String toolName = "get_weather";
        Map<String, Object> args = Map.of("location", "Boston");

        when(event.content()).thenReturn(Optional.of(content));
        when(content.parts()).thenReturn(Optional.of(List.of(part)));
        when(part.functionCall()).thenReturn(Optional.of(functionCall));

        mockFunctionCall(toolCallId, toolName, Optional.of(args));
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.empty());
        when(context.lacksPredictiveStateForTool(anyString())).thenReturn(true);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(3);
        testSubscriber.assertComplete();

        ToolCallStartEvent startEvent = (ToolCallStartEvent) testSubscriber.values().get(0);
        assertEquals(toolCallId, startEvent.getToolCallId());
        assertEquals(toolName, startEvent.getToolCallName());

        ToolCallArgsEvent argsEvent = (ToolCallArgsEvent) testSubscriber.values().get(1);
        assertEquals(toolCallId, argsEvent.getToolCallId());
        assertEquals("{\"location\":\"Boston\"}", argsEvent.getDelta());

        ToolCallEndEvent endEvent = (ToolCallEndEvent) testSubscriber.values().get(2);
        assertEquals(toolCallId, endEvent.getToolCallId());
    }

    @Test
    void shouldEmitTextEndEventFirst_whenTextStreamIsActiveAndFunctionCallArrives() {
        // Arrange
        when(event.content()).thenReturn(Optional.of(content));
        when(content.parts()).thenReturn(Optional.of(List.of(part)));
        when(part.functionCall()).thenReturn(Optional.of(functionCall));
        
        String activeMessageId = "active-stream-id-123";
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.of(activeMessageId));
        
        mockFunctionCall("tool-call-id-789", "some_tool", Optional.empty());
        when(context.lacksPredictiveStateForTool(anyString())).thenReturn(true);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(3);
        testSubscriber.assertComplete();
        
        BaseEvent firstEvent = testSubscriber.values().get(0);
        assertInstanceOf(TextMessageEndEvent.class, firstEvent);
        assertEquals(activeMessageId, ((TextMessageEndEvent) firstEvent).getMessageId());

        assertInstanceOf(ToolCallStartEvent.class, testSubscriber.values().get(1));
    }
}
