package com.agui.adk;

import com.agui.core.event.BaseEvent;
import com.agui.core.event.TextMessageContentEvent;
import com.agui.core.event.ToolCallArgsEvent;
import com.agui.core.type.EventType;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class EventTranslatorTest {

    private EventTranslator eventTranslator;

    @BeforeEach
    void setUp() {
        eventTranslator = new EventTranslator();
    }

    @Test
    void translate_shouldConvertTextPartToTextMessageEvents() {
        // --- Setup ---
        // Create a mock ADK Event with a text part
        Event adkEvent = mock(Event.class);
        Part textPart = mock(Part.class);
        Content content = mock(Content.class);

        when(textPart.text()).thenReturn(Optional.of("Hello "));
        when(textPart.functionCall()).thenReturn(Optional.empty());
        when(content.parts()).thenReturn(Optional.of(List.of(textPart)));
        when(adkEvent.content()).thenReturn(Optional.of(content));

        // --- Execution ---
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        eventTranslator.translate(adkEvent).subscribe(testSubscriber);

        // --- Verification ---
        testSubscriber.assertValueCount(2);
        testSubscriber.assertValueAt(0, e -> e.getType() == EventType.TEXT_MESSAGE_START);
        testSubscriber.assertValueAt(1, e -> e.getType() == EventType.TEXT_MESSAGE_CONTENT
                && ((TextMessageContentEvent) e).getDelta().equals("Hello "));
        testSubscriber.assertComplete();
    }

    @Test
    void translate_shouldConvertFunctionCallPartToToolEvents() {
        // --- Setup ---
        // Create a real FunctionCall object instead of mocking it to make the test more robust.
        FunctionCall functionCall = FunctionCall.builder()
                .name("get_weather")
                .args(Map.of("location", "Paris"))
                .build();

        Part functionPart = Part.builder().functionCall(functionCall).build();
        Content content = Content.builder().parts(List.of(functionPart)).build();
        Event adkEvent = Event.builder().content(content).build();

        // --- Execution ---
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        eventTranslator.translate(adkEvent).subscribe(testSubscriber);

        // --- Verification ---
        testSubscriber.assertComplete();
        testSubscriber.assertValueCount(3);

        List<BaseEvent> events = testSubscriber.values();

        assertThat(events.get(0).getType()).isEqualTo(EventType.TOOL_CALL_START);

        BaseEvent argsEvent = events.get(1);
        assertThat(argsEvent.getType()).isEqualTo(EventType.TOOL_CALL_ARGS);
        assertThat(((ToolCallArgsEvent) argsEvent).getDelta()).contains("\"location\"").contains("\"Paris\"");

        assertThat(events.get(2).getType()).isEqualTo(EventType.TOOL_CALL_END);
    }

    @Test
    void forceCloseStreamingMessage_shouldEmitEndEvent_whenStreaming() {
        // --- Setup ---
        // Simulate the start of a text stream
        Event adkEvent = mock(Event.class);
        Part textPart = mock(Part.class);
        Content content = mock(Content.class);
        when(textPart.text()).thenReturn(Optional.of("Some text"));
        when(textPart.functionCall()).thenReturn(Optional.empty());
        when(content.parts()).thenReturn(Optional.of(List.of(textPart)));
        when(adkEvent.content()).thenReturn(Optional.of(content));
        // Use blockingSubscribe to ensure the state is set before proceeding.
        Flowable.fromPublisher(eventTranslator.translate(adkEvent)).blockingSubscribe();

        // --- Execution ---
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        eventTranslator.forceCloseStreamingMessage().subscribe(testSubscriber);

        // --- Verification ---
        testSubscriber.assertValueCount(1);
        testSubscriber.assertValueAt(0, e -> e.getType() == EventType.TEXT_MESSAGE_END);
        testSubscriber.assertComplete();
    }

    @Test
    void forceCloseStreamingMessage_shouldEmitNothing_whenNotStreaming() {
        // --- Execution ---
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        eventTranslator.forceCloseStreamingMessage().subscribe(testSubscriber);

        // --- Verification ---
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }
}