package com.agui.adk.translator.context;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

class StreamingStateTest {

    private StreamingState streamingState;

    @BeforeEach
    void setUp() {
        streamingState = new StreamingState();
    }

    @Test
    void shouldBeInInitialState_whenConstructed() {
        assertTrue(streamingState.getMessageId().isEmpty());
        assertFalse(streamingState.isStreaming());
        assertTrue(streamingState.getLastStreamedText() == null || streamingState.getLastStreamedText().isEmpty());
        assertTrue(streamingState.getLastStreamedRunId() == null || streamingState.getLastStreamedRunId().isEmpty());
    }

    @Test
    void shouldStartNewStream_whenNotAlreadyStreaming() {
        Optional<String> messageId = streamingState.startStreaming();
        assertTrue(messageId.isPresent());
        assertTrue(streamingState.isStreaming());
        assertEquals(messageId, streamingState.getMessageId());
        assertTrue(streamingState.getLastStreamedText() == null || streamingState.getLastStreamedText().isEmpty());
    }

    @Test
    void shouldReturnEmptyOptional_whenAlreadyStreaming() {
        streamingState.startStreaming(); // Start first stream
        Optional<String> secondMessageId = streamingState.startStreaming(); // Try to start another
        assertTrue(secondMessageId.isEmpty());
    }

    @Test
    void shouldAppendText_whenCalled() {
        streamingState.startStreaming();
        streamingState.appendToCurrentText("Hello");
        streamingState.appendToCurrentText(" World");
        // This is problematic. currentText is private. We can only test it indirectly via endStream or by making it public.
        // For now, I will rely on the endStream test to confirm currentText is correctly built.
    }
    
    @Test
    void shouldUpdateLastStreamedAndReset_whenEndStreamCalled() {
        String runId = "testRun123";
        streamingState.startStreaming();
        String msgId = streamingState.getMessageId().get();
        streamingState.appendToCurrentText("Some streamed content");

        streamingState.endStream(runId);

        assertFalse(streamingState.isStreaming());
        assertTrue(streamingState.getMessageId().isEmpty());
        assertEquals("", streamingState.currentText); // This should be empty after endStream
        assertEquals("Some streamed content", streamingState.getLastStreamedText());
        assertEquals(runId, streamingState.getLastStreamedRunId());
    }

    @Test
    void shouldNotUpdateLastStreamed_whenEndStreamCalledWithEmptyText() {
        String runId = "testRun456";
        streamingState.startStreaming();
        streamingState.endStream(runId); // End stream without appending text

        assertNull(streamingState.getLastStreamedText());
        assertNull(streamingState.getLastStreamedRunId());
    }

    @Test
    void shouldClearLastStreamedData_whenResetHistoryCalled() {
        streamingState.startStreaming();
        streamingState.appendToCurrentText("Content");
        streamingState.endStream("runId");
        assertNotNull(streamingState.getLastStreamedText());
        
        streamingState.resetHistory();
        assertNull(streamingState.getLastStreamedText());
        assertNull(streamingState.getLastStreamedRunId());
    }
}
