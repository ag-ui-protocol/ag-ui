package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.adk.translator.context.StreamingState;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.TextMessageContentEvent;
import com.agui.core.event.TextMessageEndEvent;
import com.agui.core.event.TextMessageStartEvent;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;

import static org.mockito.Mockito.anyString;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class TextMessageStreamStepTest {

    private TextMessageStreamStep translationStep;

    @Mock
    private Event event;
    @Mock
    private TranslationContext context;
    @Mock
    private Content content;
    @Mock
    private Part part;

    @BeforeEach
    void setUp() {
        translationStep = TextMessageStreamStep.INSTANCE;
    }

    private void setupDefaultMocks() {
        when(event.content()).thenReturn(Optional.of(content));
        when(content.parts()).thenReturn(Optional.of(List.of(part)));
        when(part.text()).thenReturn(Optional.of(""));
    }

    private void mockEventText(String text) {
        when(part.text()).thenReturn(Optional.of(text));
    }

    @Test
    void shouldEmitStartContentEnd_whenNonStreamedFinalResponse() {
        // Arrange
        setupDefaultMocks();
        mockEventText("Hello");
        when(event.finalResponse()).thenReturn(true);
        when(context.handleDuplicateOrEmptyStream("Hello")).thenReturn(Optional.of("Hello"));

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertValueCount(3);
        testSubscriber.assertValueAt(0, v -> v instanceof TextMessageStartEvent);
        testSubscriber.assertValueAt(1, v -> v instanceof TextMessageContentEvent && ((TextMessageContentEvent)v).getDelta().equals("Hello"));
        testSubscriber.assertValueAt(2, v -> v instanceof TextMessageEndEvent);
        testSubscriber.assertComplete();
    }
    
    @Test
    void shouldEmitStartContentEndInSequence_whenStreamedMessageReceived() {
        // Arrange
        setupDefaultMocks();
        String messageId = "stream-msg-123";
        when(context.getStreamingMessageId()).thenReturn(Optional.of(messageId));

        // --- Part 1: Start of stream ---
        mockEventText("Hello ");
        when(event.finalResponse()).thenReturn(false);
        when(event.partial()).thenReturn(Optional.of(true));
        when(context.startStreamingIfNeeded()).thenReturn(Optional.of(messageId));
        when(context.isStreaming()).thenReturn(false);

        // Act 1 & Assert 1
        translationStep.translate(event, context).test().assertValueCount(2);
        
        // --- Part 2: Middle of stream ---
        when(context.isStreaming()).thenReturn(true);
        when(context.startStreamingIfNeeded()).thenReturn(Optional.empty());
        mockEventText("world!");

        // Act 2 & Assert 2
        translationStep.translate(event, context).test().assertValueCount(1);

        // --- Part 3: End of stream ---
        mockEventText("");
        when(event.finalResponse()).thenReturn(true);
        when(context.forceCloseStreamingMessage()).thenReturn(Optional.of(messageId));
        when(context.handleDuplicateOrEmptyStream(anyString())).thenReturn(Optional.empty());

        // Act 3 & Assert 3
        translationStep.translate(event, context).test().assertValueCount(1);
    }
    
    @Test
    void shouldReturnEmpty_whenDuplicateFinalResponseReceived() {
        // Arrange
        setupDefaultMocks();
        String duplicateText = "This is a duplicate message.";
        mockEventText(duplicateText);
        when(event.finalResponse()).thenReturn(true);
        when(context.handleDuplicateOrEmptyStream(duplicateText)).thenReturn(Optional.empty());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = translationStep.translate(event, context).test();

        // Assert
        testSubscriber.assertNoValues();
        testSubscriber.assertComplete();
    }
}

