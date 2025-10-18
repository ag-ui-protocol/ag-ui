package com.agui.chatapp.java.model;

import com.agui.core.types.Role;

import org.junit.Test;
import org.junit.Before;

import static org.junit.Assert.*;

/**
 * Unit tests for ChatMessage model class.
 * Tests streaming functionality, content management, and state transitions.
 */
public class ChatMessageTest {

    private ChatMessage staticMessage;
    private ChatMessage streamingMessage;

    @Before
    public void setUp() {
        staticMessage = new ChatMessage("test-id", Role.ASSISTANT, "Hello", null);
        streamingMessage = ChatMessage.createStreaming("streaming-id", Role.ASSISTANT, null);
    }

    @Test
    public void testStaticMessageProperties() {
        assertEquals("test-id", staticMessage.getId());
        assertEquals(Role.ASSISTANT, staticMessage.getRole());
        assertEquals("Hello", staticMessage.getContent());
        assertEquals("Assistant", staticMessage.getSenderDisplayName());
        assertFalse(staticMessage.isStreaming());
        assertTrue(staticMessage.hasContent());
    }

    @Test
    public void testStreamingMessageCreation() {
        assertTrue(streamingMessage.isStreaming());
        assertEquals("streaming-id", streamingMessage.getId());
        assertEquals(Role.ASSISTANT, streamingMessage.getRole());
        assertEquals("", streamingMessage.getContent()); // Empty initially
        assertFalse(streamingMessage.hasContent()); // No content initially
    }

    @Test
    public void testStreamingContentAppending() {
        streamingMessage.appendStreamingContent("Hello");
        assertEquals("Hello", streamingMessage.getContent());
        assertTrue(streamingMessage.hasContent());
        assertTrue(streamingMessage.isStreaming());

        streamingMessage.appendStreamingContent(" World");
        assertEquals("Hello World", streamingMessage.getContent());
        assertTrue(streamingMessage.isStreaming());
    }

    @Test
    public void testFinishStreaming() {
        streamingMessage.appendStreamingContent("Test content");
        assertTrue(streamingMessage.isStreaming());

        streamingMessage.finishStreaming();
        assertFalse(streamingMessage.isStreaming());
        assertEquals("Test content", streamingMessage.getContent());
        assertTrue(streamingMessage.hasContent());
    }

    @Test
    public void testRoleBasedDisplayNames() {
        ChatMessage userMessage = new ChatMessage("1", Role.USER, "Hi", null);
        ChatMessage systemMessage = new ChatMessage("2", Role.SYSTEM, "System", null);
        ChatMessage toolMessage = new ChatMessage("3", Role.TOOL, "Tool", null);

        assertEquals("You", userMessage.getSenderDisplayName());
        assertEquals("System", systemMessage.getSenderDisplayName());
        assertEquals("Tool", toolMessage.getSenderDisplayName());
    }

    @Test
    public void testCustomNameOverride() {
        ChatMessage namedMessage = new ChatMessage("1", Role.ASSISTANT, "Hi", "Claude");
        assertEquals("Claude", namedMessage.getSenderDisplayName());
    }

    @Test
    public void testMessageEquality() {
        ChatMessage message1 = new ChatMessage("same-id", Role.USER, "Hello", null);
        ChatMessage message2 = new ChatMessage("same-id", Role.ASSISTANT, "Hi", null);
        ChatMessage message3 = new ChatMessage("different-id", Role.USER, "Hello", null);

        assertEquals(message1, message2); // Same ID
        assertNotEquals(message1, message3); // Different ID
        assertEquals(message1.hashCode(), message2.hashCode());
    }

    @Test
    public void testEmptyContentHandling() {
        ChatMessage emptyMessage = new ChatMessage("1", Role.USER, "", null);
        ChatMessage nullMessage = new ChatMessage("2", Role.USER, null, null);

        assertFalse(emptyMessage.hasContent());
        assertFalse(nullMessage.hasContent());
        assertEquals("", emptyMessage.getContent());
        assertEquals("", nullMessage.getContent());
    }

    @Test
    public void testTimestampFormatting() {
        String formatted = staticMessage.getFormattedTimestamp();
        assertNotNull(formatted);
        assertTrue(formatted.matches("\\d{1,2}:\\d{2} (AM|PM)"));
    }

    @Test
    public void testRoleTypeCheckers() {
        ChatMessage userMsg = new ChatMessage("1", Role.USER, "Hi", null);
        ChatMessage assistantMsg = new ChatMessage("2", Role.ASSISTANT, "Hello", null);
        ChatMessage systemMsg = new ChatMessage("3", Role.SYSTEM, "System", null);

        assertTrue(userMsg.isUser());
        assertFalse(userMsg.isAssistant());
        assertFalse(userMsg.isSystem());

        assertTrue(assistantMsg.isAssistant());
        assertFalse(assistantMsg.isUser());
        assertFalse(assistantMsg.isSystem());

        assertTrue(systemMsg.isSystem());
        assertFalse(systemMsg.isUser());
        assertFalse(systemMsg.isAssistant());
    }
}