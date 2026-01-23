package com.agui.adk.processor;

import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

class MessageChunkTest {

    // Helper to create a dummy message
    private BaseMessage createDummyUserMessage(String content) {
        UserMessage message = new UserMessage();
        message.setContent(content);
        return message;
    }

    private BaseMessage createDummyToolMessage(String content) {
        // Assuming ToolMessage exists or BaseMessage is enough for list content
        // For actual ToolMessage, it would be 'new ToolMessage()' and set content/toolCallId
        UserMessage message = new UserMessage(); // Using UserMessage as a placeholder for BaseMessage
        message.setContent(content);
        return message;
    }

    @Test
    void shouldReturnFalse_whenToolMessagesAreEmpty() {
        // Arrange
        MessageChunk chunk = new MessageChunk(List.of(), List.of(createDummyUserMessage("user_msg")));

        // Act & Assert
        assertFalse(chunk.isToolSubmission(), "Expected isToolSubmission() to be false for empty toolMessages");
    }

    @Test
    void shouldReturnTrue_whenToolMessagesAreNotEmpty() {
        // Arrange
        MessageChunk chunk = new MessageChunk(List.of(createDummyToolMessage("tool_msg")), List.of());

        // Act & Assert
        assertTrue(chunk.isToolSubmission(), "Expected isToolSubmission() to be true for non-empty toolMessages");
    }

    @Test
    void shouldCreateCorrectChunk_whenFromUserSystemChunkIsCalled() {
        // Arrange
        List<BaseMessage> userMessages = List.of(createDummyUserMessage("user_msg_1"), createDummyUserMessage("user_msg_2"));

        // Act
        MessageChunk chunk = MessageChunk.fromUserSystemChunk(userMessages);

        // Assert
        assertTrue(chunk.toolMessages().isEmpty(), "Expected toolMessages to be empty for user-system chunk");
        assertEquals(userMessages, chunk.userSystemMessages(), "Expected userSystemMessages to match input");
        assertFalse(chunk.isToolSubmission(), "Expected isToolSubmission() to be false for user-system chunk");
    }

    @Test
    void shouldSetFieldsCorrectly_whenConstructed() {
        // Arrange
        List<BaseMessage> toolMessages = List.of(createDummyToolMessage("tool_msg_1"));
        List<BaseMessage> userMessages = List.of(createDummyUserMessage("user_msg_1"));

        // Act
        MessageChunk chunk = new MessageChunk(toolMessages, userMessages);

        // Assert
        assertEquals(toolMessages, chunk.toolMessages(), "Expected toolMessages to match input");
        assertEquals(userMessages, chunk.userSystemMessages(), "Expected userSystemMessages to match input");
        assertTrue(chunk.isToolSubmission(), "Expected isToolSubmission() to be true for chunk with tool messages");
    }
}
