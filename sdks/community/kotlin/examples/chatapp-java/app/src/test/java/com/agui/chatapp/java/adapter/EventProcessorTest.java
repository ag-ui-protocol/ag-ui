package com.agui.chatapp.java.adapter;

import com.agui.core.types.*;

import org.junit.Test;
import org.junit.Before;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import static org.junit.Assert.*;
import static org.mockito.Mockito.*;

/**
 * Unit tests for EventProcessor class.
 * Tests event type classification and handler delegation.
 */
public class EventProcessorTest {

    @Mock
    private EventProcessor.EventHandler mockHandler;

    @Before
    public void setUp() {
        MockitoAnnotations.openMocks(this);
    }

    @Test
    public void testProcessTextMessageStartEvent() {
        TextMessageStartEvent event = new TextMessageStartEvent("msg-123", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onTextMessageStart(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessTextMessageContentEvent() {
        TextMessageContentEvent event = new TextMessageContentEvent("msg-123", "Hello", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onTextMessageContent(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessTextMessageEndEvent() {
        TextMessageEndEvent event = new TextMessageEndEvent("msg-123", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onTextMessageEnd(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessRunStartedEvent() {
        RunStartedEvent event = new RunStartedEvent("thread-1", "run-123", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onRunStarted(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessRunFinishedEvent() {
        RunFinishedEvent event = new RunFinishedEvent("thread-1", "run-123", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onRunFinished(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessRunErrorEvent() {
        RunErrorEvent event = new RunErrorEvent("Connection failed", "CONN_ERROR", null, null);
        
        EventProcessor.processEvent(event, mockHandler);
        
        verify(mockHandler).onRunError(event);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessStepEvents() {
        StepStartedEvent startEvent = new StepStartedEvent("reasoning", null, null);
        StepFinishedEvent finishEvent = new StepFinishedEvent("reasoning", null, null);
        
        EventProcessor.processEvent(startEvent, mockHandler);
        EventProcessor.processEvent(finishEvent, mockHandler);
        
        verify(mockHandler).onStepStarted(startEvent);
        verify(mockHandler).onStepFinished(finishEvent);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testProcessToolCallEvents() {
        ToolCallStartEvent startEvent = new ToolCallStartEvent("call-123", "search", "msg-456", null, null);
        ToolCallArgsEvent argsEvent = new ToolCallArgsEvent("call-123", "{\"query\":", null, null);
        ToolCallEndEvent endEvent = new ToolCallEndEvent("call-123", null, null);
        
        EventProcessor.processEvent(startEvent, mockHandler);
        EventProcessor.processEvent(argsEvent, mockHandler);
        EventProcessor.processEvent(endEvent, mockHandler);
        
        verify(mockHandler).onToolCallStart(startEvent);
        verify(mockHandler).onToolCallArgs(argsEvent);
        verify(mockHandler).onToolCallEnd(endEvent);
        verifyNoMoreInteractions(mockHandler);
    }

    @Test
    public void testEventTypeClassification() {
        // Text message events
        assertTrue(EventProcessor.isTextMessageEvent(new TextMessageStartEvent("1", null, null)));
        assertTrue(EventProcessor.isTextMessageEvent(new TextMessageContentEvent("1", "text", null, null)));
        assertTrue(EventProcessor.isTextMessageEvent(new TextMessageEndEvent("1", null, null)));
        
        // Tool call events
        assertTrue(EventProcessor.isToolCallEvent(new ToolCallStartEvent("1", "tool", null, null, null)));
        assertTrue(EventProcessor.isToolCallEvent(new ToolCallArgsEvent("1", "args", null, null)));
        assertTrue(EventProcessor.isToolCallEvent(new ToolCallEndEvent("1", null, null)));
        
        // Lifecycle events
        assertTrue(EventProcessor.isLifecycleEvent(new RunStartedEvent("t", "r", null, null)));
        assertTrue(EventProcessor.isLifecycleEvent(new RunFinishedEvent("t", "r", null, null)));
        assertTrue(EventProcessor.isLifecycleEvent(new RunErrorEvent("error", null, null, null)));
        assertTrue(EventProcessor.isLifecycleEvent(new StepStartedEvent("step", null, null)));
        assertTrue(EventProcessor.isLifecycleEvent(new StepFinishedEvent("step", null, null)));
        
        // Cross-category tests
        assertFalse(EventProcessor.isTextMessageEvent(new RunStartedEvent("t", "r", null, null)));
        assertFalse(EventProcessor.isToolCallEvent(new TextMessageStartEvent("1", null, null)));
        assertFalse(EventProcessor.isLifecycleEvent(new ToolCallStartEvent("1", "tool", null, null, null)));
    }

    @Test
    public void testEventDescriptions() {
        assertEquals("Run Started", EventProcessor.getEventDescription(new RunStartedEvent("t", "r", null, null)));
        assertEquals("Text Message Start", EventProcessor.getEventDescription(new TextMessageStartEvent("1", null, null)));
        assertEquals("Tool Call Args", EventProcessor.getEventDescription(new ToolCallArgsEvent("1", "args", null, null)));
        // Create a simple JSON element for the CustomEvent
        kotlinx.serialization.json.JsonElement jsonValue = kotlinx.serialization.json.JsonElementKt.JsonPrimitive("test");
        assertEquals("Custom Event", EventProcessor.getEventDescription(new CustomEvent("test", jsonValue, null, null)));
    }

    @Test
    public void testUnknownEventHandling() {
        // Create a simple JSON element for the RawEvent
        kotlinx.serialization.json.JsonElement jsonValue = kotlinx.serialization.json.JsonElementKt.JsonPrimitive("test");
        RawEvent unknownEvent = new RawEvent(jsonValue, null, null, null);
        
        EventProcessor.processEvent(unknownEvent, mockHandler);
        
        verify(mockHandler).onRawEvent(unknownEvent);
        verifyNoMoreInteractions(mockHandler);
    }
}