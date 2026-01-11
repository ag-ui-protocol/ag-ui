package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.ToolCallResultEvent;
import com.google.adk.events.Event;
import com.google.common.collect.ImmutableList;
import com.google.genai.types.FunctionResponse;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
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
        translationStep = ToolCallResponseStep.INSTANCE;
    }

    @Test
    void shouldReturnEmpty_whenFunctionResponsesAreNull() {
        when(event.functionResponses()).thenReturn(null);

        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldReturnEmpty_whenFunctionResponsesAreEmpty() {
        when(event.functionResponses()).thenReturn(ImmutableList.of());

        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldEmitResultEvent_whenFunctionResponseIsValid() {
        String toolCallId = "res-123";
        Map<String, Object> responseData = Map.of("weather", "sunny");
        when(functionResponse.id()).thenReturn(Optional.of(toolCallId));
        when(functionResponse.response()).thenReturn(Optional.of(responseData));
        when(event.functionResponses()).thenReturn(ImmutableList.of(functionResponse));
        
        when(context.isLongRunningTool(anyString())).thenReturn(false);
        when(context.isPredictiveStateTool(anyString())).thenReturn(false);

        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        testSubscriber.assertValueCount(1);
        testSubscriber.assertComplete();

        BaseEvent emittedEvent = testSubscriber.values().get(0);
        assertInstanceOf(ToolCallResultEvent.class, emittedEvent);

        ToolCallResultEvent resultEvent = (ToolCallResultEvent) emittedEvent;
        assertEquals(toolCallId, resultEvent.getToolCallId());
        assertEquals("{\"weather\":\"sunny\"}", resultEvent.getContent());
    }

    @Test
    void shouldBeFiltered_whenResponseIsFromLongRunningTool() {
        when(functionResponse.id()).thenReturn(Optional.of("lro-123"));
        when(event.functionResponses()).thenReturn(ImmutableList.of(functionResponse));
        
        when(context.isLongRunningTool("lro-123")).thenReturn(true);
        when(context.isPredictiveStateTool("lro-123")).thenReturn(false);

        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }

    @Test
    void shouldBeFiltered_whenResponseIsFromPredictiveStateTool() {
        when(functionResponse.id()).thenReturn(Optional.of("predictive-123"));
        when(event.functionResponses()).thenReturn(ImmutableList.of(functionResponse));
        
        when(context.isLongRunningTool("predictive-123")).thenReturn(false);
        when(context.isPredictiveStateTool("predictive-123")).thenReturn(true);

        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }
}
