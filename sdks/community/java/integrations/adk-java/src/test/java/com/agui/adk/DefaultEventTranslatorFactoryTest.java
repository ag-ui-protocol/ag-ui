package com.agui.adk;

import com.agui.core.event.BaseEvent;
import com.agui.core.type.EventType;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class DefaultEventTranslatorFactoryTest {

    private EventTranslator translator;

    @BeforeEach
    void setUp() {
        DefaultEventTranslatorFactory factory = new DefaultEventTranslatorFactory();
        translator = factory.create();
    }

    @Test
    void create_shouldReturnNonNullTranslator() {
        assertNotNull(translator);
    }

    @Test
    void translate_withTextContent_shouldProduceTextContentEvent() {
        // --- Setup ---
        var adkEvent = Event.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(Part.builder().text("Hello ").build()))
                        .build())
                .build();

        // --- Execution ---
        List<BaseEvent> aguiEvents = Flowable.fromPublisher(translator.translate(adkEvent)).toList().blockingGet();

        // --- Verification ---
        assertEquals(2, aguiEvents.size());
        assertEquals(EventType.TEXT_MESSAGE_START, aguiEvents.get(0).getType());
        assertEquals(EventType.TEXT_MESSAGE_CONTENT, aguiEvents.get(1).getType());
    }

    @Test
    void translate_withToolCall_shouldProduceToolCallEvents() {
        // --- Setup ---
        var functionCall = FunctionCall.builder()
                .name("test-tool")
                .args(Map.of("arg1", "value1"))
                .build();
        var part = Part.builder().functionCall(functionCall).build();
        var adkEvent = Event.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(part))
                        .build())
                .build();

        // --- Execution ---
        List<BaseEvent> aguiEvents = Flowable.fromPublisher(translator.translate(adkEvent)).toList().blockingGet();

        // --- Verification ---
        // Expecting START, ARGS, and END for the tool call
        assertEquals(3, aguiEvents.size());
        assertEquals(EventType.TOOL_CALL_START, aguiEvents.get(0).getType());
        assertEquals(EventType.TOOL_CALL_ARGS, aguiEvents.get(1).getType());
        assertEquals(EventType.TOOL_CALL_END, aguiEvents.get(2).getType());
    }

    @Test
    void forceCloseStreamingMessage_shouldProduceEndEvent_whenStreaming() {
        // --- Setup ---
        // 1. Start a stream by sending a text part
        var startEvent = Event.builder()
                .content(Content.builder()
                        .role("model")
                        .parts(List.of(Part.builder().text("Hello ").build()))
                        .build())
                .build();
        Flowable.fromPublisher(translator.translate(startEvent)).blockingSubscribe();

        // --- Execution ---
        // 2. Force close the stream
        List<BaseEvent> endEvents = Flowable.fromPublisher(translator.forceCloseStreamingMessage()).toList().blockingGet();

        // --- Verification ---
        // 3. Verify that a TEXT_MESSAGE_END event was emitted
        assertEquals(1, endEvents.size());
        assertEquals(EventType.TEXT_MESSAGE_END, endEvents.get(0).getType());
    }

    @Test
    void forceCloseStreamingMessage_shouldDoNothing_whenNotStreaming() {
        // --- Execution ---
        List<BaseEvent> events = Flowable.fromPublisher(translator.forceCloseStreamingMessage()).toList().blockingGet();

        // --- Verification ---
        assertTrue(events.isEmpty());
    }
}
