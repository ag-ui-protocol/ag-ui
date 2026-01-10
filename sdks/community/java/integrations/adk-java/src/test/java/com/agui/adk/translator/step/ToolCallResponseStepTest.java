package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.ToolCallResultEvent;
import com.google.genai.types.FunctionResponse;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

class ToolCallResponseStepTest {

    private ToolCallResponseStep translationStep;

    @Mock
    private Event event;

    @Mock
    private TranslationContext context;

    @Mock
    private FunctionResponse functionResponse;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        translationStep = ToolCallResponseStep.INSTANCE;
    }

    @Test
    void shouldReturnEmpty_whenFunctionResponsesAreNull() {
        // Arrange
        when(event.functionResponses()).thenReturn(null);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldReturnEmpty_whenFunctionResponsesAreEmpty() {
        // Arrange
        when(event.functionResponses()).thenReturn(List.of());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldEmitResultEvent_whenFunctionResponseIsValid() {
        // Arrange
        String toolCallId = "res-123";
        Map<String, String> responseData = Map.of("weather", "sunny");
        when(functionResponse.id()).thenReturn(Optional.of(toolCallId));
        when(functionResponse.response()).thenReturn(Optional.of(responseData));
        when(event.functionResponses()).thenReturn(List.of(functionResponse));
        
        // Mock the context to indicate this is a normal tool
        when(context.isLongRunningTool(anyString())).thenReturn(false);
        when(context.isPredictiveStateTool(anyString())).thenReturn(false);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(1);
        testSubscriber.assertComplete();

        BaseEvent emittedEvent = testSubscriber.values().get(0);
        assertInstanceOf(ToolCallResultEvent.class, emittedEvent);

        ToolCallResultEvent resultEvent = (ToolCallResultEvent) emittedEvent;
        assertEquals(toolCallId, resultEvent.getToolCallId());
        assertEquals("{\"weather\":\"sunny\"}", resultEvent.getContent());
    }
    @Test
    void translate_withLongRunningToolResponse_shouldBeFiltered() {
        // Arrange
        when(functionResponse.id()).thenReturn(Optional.of("lro-123"));
        when(event.functionResponses()).thenReturn(List.of(functionResponse));
        
        // Mock the context to indicate this is a long-running tool
        when(context.isLongRunningTool("lro-123")).thenReturn(true);
        when(context.isPredictiveStateTool("lro-123")).thenReturn(false);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void translate_withPredictiveStateToolResponse_shouldBeFiltered() {
        // Arrange
        when(functionResponse.id()).thenReturn(Optional.of("predictive-123"));
        when(event.functionResponses()).thenReturn(List.of(functionResponse));
        
        // Mock the context to indicate this is a predictive state tool
        when(context.isLongRunningTool("predictive-123")).thenReturn(false);
        when(context.isPredictiveStateTool("predictive-123")).thenReturn(true);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    // More tests will be added
}
