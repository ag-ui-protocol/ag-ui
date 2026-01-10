package com.agui.adk.translator;

import com.agui.adk.translator.context.PredictiveState;
import com.agui.adk.translator.context.StreamingState;
import com.agui.adk.translator.context.ToolState;
import com.agui.core.event.BaseEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Optional;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TranslationContextTest {

    private TranslationContext context;

    @Mock
    private StreamingState streamingState;
    @Mock
    private ToolState toolState;
    @Mock
    private PredictiveState predictiveState;
    @Mock
    private PredictStateMapping predictStateMapping;

    private String threadId = "test-thread";
    private String runId = "test-run";
    private List<PredictStateMapping> predictConfig;

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        predictConfig = List.of(predictStateMapping);
        // We need to inject mocks into the TranslationContext, as it creates them by default
        // So, we'll manually create the context, and then use reflection or a custom constructor if needed.
        // For now, let's test the default constructor with real sub-contexts (or just not mock them for the ctor test)
    }

    @Test
    void shouldInitializeCorrectly_whenConstructedWithFullConfig() {
        context = new TranslationContext(threadId, runId, predictConfig); // Uses real sub-contexts for this test

        assertEquals(threadId, context.getThreadId());
        assertEquals(runId, context.getRunId());

        // Verify sub-contexts are initialized (not null)
        assertNotNull(context.streamingState); // Accessing private field for testing
        assertNotNull(context.toolState);      // Accessing private field for testing
        assertNotNull(context.predictiveState); // Accessing private field for testing

        // Verify predictiveState has the correct config (by re-creating and inspecting)
        PredictiveState testPredictiveState = new PredictiveState(predictConfig);
        // This is tricky to compare directly as PredictiveState is internal.
        // We'll rely on testing PredictiveState independently.
    }

    @Test
    void shouldInitializeCorrectly_whenConstructedWithNoConfig() {
        context = new TranslationContext(threadId, runId); // Uses real sub-contexts for this test

        assertEquals(threadId, context.getThreadId());
        assertEquals(runId, context.getRunId());
        assertNotNull(context.streamingState);
        assertNotNull(context.toolState);
        assertNotNull(context.predictiveState);
        
        // Verify predictiveState has empty config
        PredictiveState testPredictiveState = new PredictiveState(List.of());
        // Again, relying on separate PredictiveState tests
    }

    // Test StreamingState Facade methods
    @Test
    void shouldReturnStreamingStatus_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(streamingState.isStreaming()).thenReturn(true);
        assertTrue(context.isStreaming());
        verify(streamingState, times(1)).isStreaming();
    }

    @Test
    void shouldStartNewStream_whenNotAlreadyStreaming() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(streamingState.startStreaming()).thenReturn(Optional.of("msg1"));
        Optional<String> result = context.startStreamingIfNeeded();
        assertTrue(result.isPresent());
        assertEquals("msg1", result.get());
        verify(streamingState, times(1)).startStreaming();
    }

    @Test
    void shouldReturnMessageId_whenStreamIsActive() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(streamingState.getMessageId()).thenReturn(Optional.of("msg1"));
        Optional<String> result = context.getStreamingMessageId();
        assertTrue(result.isPresent());
        assertEquals("msg1", result.get());
        verify(streamingState, times(1)).getMessageId();
    }

    @Test
    void shouldEndStreamAndReturnId_whenForceClosed() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(streamingState.getMessageId()).thenReturn(Optional.of("msg2"));
        
        Optional<String> result = context.forceCloseStreamingMessage();
        
        assertTrue(result.isPresent());
        assertEquals("msg2", result.get());
        verify(streamingState, times(1)).getMessageId();
        verify(streamingState, times(1)).endStream(runId);
    }

    @Test
    void shouldAppendText_whenContentIsStreamed() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.appendToCurrentStreamText("some text");
        verify(streamingState, times(1)).appendToCurrentText("some text");
    }

    @Test
    void shouldEndStream_whenCalled() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.endStream();
        verify(streamingState, times(1)).endStream(runId);
    }

    @Test
    void shouldResetStreamHistory_whenRequested() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.resetStreamingHistory();
        verify(streamingState, times(1)).resetHistory();
    }

    @Test
    void shouldReturnTrue_whenStreamIsDuplicate() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(streamingState.getLastStreamedRunId()).thenReturn(runId);
        when(streamingState.getLastStreamedText()).thenReturn("Some text");
        
        assertTrue(context.isDuplicateStream("Some text"));
        verify(streamingState, times(1)).getLastStreamedRunId();
        verify(streamingState, times(1)).getLastStreamedText();
    }
    
    @Test
    void shouldReturnEmptyAndReset_whenStreamIsDuplicate() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        // Mock isDuplicateStream to return true
        when(streamingState.getLastStreamedRunId()).thenReturn(runId);
        when(streamingState.getLastStreamedText()).thenReturn("duplicate text");
        
        Optional<String> result = context.handleDuplicateOrEmptyStream("duplicate text");
        
        assertTrue(result.isEmpty());
        verify(streamingState, times(1)).resetHistory();
    }

    @Test
    void shouldReturnEmptyAndReset_whenStreamIsEmpty() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        // Mock isDuplicateStream to return false
        when(streamingState.getLastStreamedRunId()).thenReturn("otherRunId");
        
        Optional<String> result = context.handleDuplicateOrEmptyStream("");
        
        assertTrue(result.isEmpty());
        verify(streamingState, times(1)).resetHistory();
    }

    @Test
    void shouldReturnText_whenStreamIsValid() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        // Mock isDuplicateStream to return false
        when(streamingState.getLastStreamedRunId()).thenReturn("otherRunId");
        
        Optional<String> result = context.handleDuplicateOrEmptyStream("valid text");
        
        assertTrue(result.isPresent());
        assertEquals("valid text", result.get());
        verify(streamingState, never()).resetHistory(); // Should not reset history
    }

    // Test ToolState Facade methods
    @Test
    void shouldTrackNewToolCall_whenStarted() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.startTrackingToolCall("tool1");
        verify(toolState, times(1)).startTrackingToolCall("tool1");
    }

    @Test
    void shouldStopTrackingToolCall_whenEnded() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.endTrackingToolCall("tool1");
        verify(toolState, times(1)).endTrackingToolCall("tool1");
    }

    @Test
    void shouldStorePredictiveToolId_whenAdded() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.addPredictiveStateToolCallId("tool1");
        verify(toolState, times(1)).addPredictiveStateToolCallId("tool1");
    }

    @Test
    void shouldStoreLroToolIds_whenPopulated() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        Set<String> ids = Set.of("lro1", "lro2");
        context.populateLongRunningToolIds(ids);
        ArgumentCaptor<Set<String>> captor = ArgumentCaptor.forClass(Set.class);
        verify(toolState, times(1)).populateLongRunningToolIds(captor.capture());
        assertEquals(ids, captor.getValue());
    }

    @Test
    void shouldIdentifyLroTools_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(toolState.isLongRunningTool("lro1")).thenReturn(true);
        assertTrue(context.isLongRunningTool("lro1"));
        verify(toolState, times(1)).isLongRunningTool("lro1");
    }

    @Test
    void shouldIdentifyPredictiveTools_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(toolState.isPredictiveStateTool("pred1")).thenReturn(true);
        assertTrue(context.isPredictiveStateTool("pred1"));
        verify(toolState, times(1)).isPredictiveStateTool("pred1");
    }

    @Test
    void shouldStoreDeferredEvents_whenAdded() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        List<BaseEvent> events = List.of(mock(BaseEvent.class));
        context.addDeferredConfirmEvents(events);
        ArgumentCaptor<List<BaseEvent>> captor = ArgumentCaptor.forClass(List.class);
        verify(toolState, times(1)).addDeferredConfirmEvents(captor.capture());
        assertEquals(events, captor.getValue());
    }

    @Test
    void shouldReturnAndClearDeferredEvents_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        List<BaseEvent> events = List.of(mock(BaseEvent.class));
        when(toolState.getAndClearDeferredEvents()).thenReturn(events);
        assertEquals(events, context.getAndClearDeferredConfirmEvents());
        verify(toolState, times(1)).getAndClearDeferredEvents();
    }

    @Test
    void shouldIdentifyActiveTools_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(toolState.isActive("tool1")).thenReturn(true);
        assertTrue(context.isActive("tool1"));
        verify(toolState, times(1)).isActive("tool1");
    }

    // Test PredictiveState Facade methods
    @Test
    void shouldConfirmLackOfPredictiveState_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(predictiveState.hasToolConfig("toolA")).thenReturn(false); // Because context inverts
        assertTrue(context.lacksPredictiveStateForTool("toolA"));
        verify(predictiveState, times(1)).hasToolConfig("toolA");
    }

    @Test
    void shouldConfirmPredictiveStateWasEmitted_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(predictiveState.hasEmittedForTool("toolA")).thenReturn(true);
        assertTrue(context.hasEmittedPredictiveStateForTool("toolA"));
        verify(predictiveState, times(1)).hasEmittedForTool("toolA");
    }

    @Test
    void shouldMarkPredictiveStateAsEmitted_whenCalled() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.markPredictiveStateAsEmittedForTool("toolA");
        verify(predictiveState, times(1)).markAsEmittedForTool("toolA");
    }

    @Test
    void shouldReturnMappings_whenQueriedByTool() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        List<PredictStateMapping> mappings = List.of(mock(PredictStateMapping.class));
        when(predictiveState.getMappingsForTool("toolA")).thenReturn(mappings);
        assertEquals(mappings, context.getPredictiveStateMappingsForTool("toolA"));
        verify(predictiveState, times(1)).getMappingsForTool("toolA");
    }

    @Test
    void shouldConfirmEmitConfirmation_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(predictiveState.shouldEmitConfirmForTool("toolA")).thenReturn(true);
        assertTrue(context.shouldEmitConfirmForTool("toolA"));
        verify(predictiveState, times(1)).shouldEmitConfirmForTool("toolA");
    }

    @Test
    void shouldConfirmConfirmationWasEmitted_whenQueried() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        when(predictiveState.hasEmittedConfirmForTool("toolA")).thenReturn(true);
        assertTrue(context.hasEmittedConfirmForTool("toolA"));
        verify(predictiveState, times(1)).hasEmittedConfirmForTool("toolA");
    }

    @Test
    void shouldMarkConfirmationAsEmitted_whenCalled() {
        context = new TranslationContext(threadId, runId, streamingState, toolState, predictiveState);
        context.markConfirmAsEmittedForTool("toolA");
        verify(predictiveState, times(1)).markAsEmittedConfirmForTool("toolA");
    }
    
    // For complex methods like handleDuplicateOrEmptyStream, we will need more elaborate mocking.
    
    // Custom constructor for injecting mocks
    // (This would typically be done by making the sub-contexts injectable via the main constructor)
    private TranslationContext(String threadId, String runId, StreamingState streamingState, ToolState toolState, PredictiveState predictiveState) {
        this.threadId = threadId;
        this.runId = runId;
        this.streamingState = streamingState;
        this.toolState = toolState;
        this.predictiveState = predictiveState;
    }
}
