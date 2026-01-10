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
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.mockito.Mockito.when;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;

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
        MockitoAnnotations.openMocks(this);
        translationStep = ToolCallRequestStep.INSTANCE;

        // Default mock behavior
        when(event.content()).thenReturn(Optional.of(content));
        when(part.functionCall()).thenReturn(Optional.of(functionCall));
        when(content.parts()).thenReturn(Optional.of(List.of(part)));
    }

    @Test
    void shouldReturnEmpty_whenNoFunctionCallsArePresent() {
        // Arrange
        when(content.parts()).thenReturn(Optional.of(List.of())); // No parts, so no function calls

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

        when(functionCall.id()).thenReturn(Optional.of(toolCallId));
        when(functionCall.name()).thenReturn(Optional.of(toolName));
        when(functionCall.args()).thenReturn(Optional.of(args));
        
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.empty());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(3);
        testSubscriber.assertComplete();

        // Verify Start Event
        ToolCallStartEvent startEvent = (ToolCallStartEvent) testSubscriber.values().get(0);
        assertEquals(toolCallId, startEvent.getToolCallId());
        assertEquals(toolName, startEvent.getToolCallName());

        // Verify Args Event
        ToolCallArgsEvent argsEvent = (ToolCallArgsEvent) testSubscriber.values().get(1);
        assertEquals(toolCallId, argsEvent.getToolCallId());
        assertEquals("{\"location\":\"Boston\"}", argsEvent.getDelta());

        // Verify End Event
        ToolCallEndEvent endEvent = (ToolCallEndEvent) testSubscriber.values().get(2);
        assertEquals(toolCallId, endEvent.getToolCallId());
    }

    @Test
    void shouldEmitTextEndEventFirst_whenTextStreamIsActiveAndFunctionCallArrives() {
        // Arrange
        String activeMessageId = "active-stream-id-123";
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.of(activeMessageId));
        
        when(functionCall.id()).thenReturn(Optional.of("tool-call-id-789"));
        when(functionCall.name()).thenReturn(Optional.of("some_tool"));
        when(functionCall.args()).thenReturn(Optional.empty());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(4); // TextMessageEnd + ToolCallStart + ToolCallEnd (no args)
        testSubscriber.assertComplete();
        
        // Verify first event is TextMessageEndEvent
        BaseEvent firstEvent = testSubscriber.values().get(0);
        assertInstanceOf(TextMessageEndEvent.class, firstEvent);
        assertEquals(activeMessageId, ((TextMessageEndEvent) firstEvent).getMessageId());

        // Verify second event is ToolCallStartEvent
        assertInstanceOf(ToolCallStartEvent.class, testSubscriber.values().get(1));
    }

    // More tests to be added
}
