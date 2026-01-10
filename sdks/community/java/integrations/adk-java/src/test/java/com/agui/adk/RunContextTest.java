package com.agui.adk;

import com.agui.core.agent.RunAgentParameters;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.agui.core.message.UserMessage;
import com.google.genai.types.Content;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class RunContextTest {

    @Test
    void shouldInitializeCorrectly_whenAllParametersProvided() {
        // Arrange
        String threadId = UUID.randomUUID().toString();
        String runId = UUID.randomUUID().toString();
        String appName = "test-app";
        String userId = "test-user";

        UserMessage userMessage = new UserMessage();
        userMessage.setRole(Role.user);
        userMessage.setContent("Hello");

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(threadId)
                .runId(runId)
                .messages(List.of(userMessage))
                .build();

        // Act
        RunContext context = new RunContext(params, appName, userId);

        // Assert
        assertEquals(appName, context.appName());
        assertEquals(userId, context.userId());
        assertEquals(threadId, context.sessionId());
        assertEquals(runId, context.runId());
        
        Content latestMessage = context.latestMessage();
        assertNotNull(latestMessage);
        assertEquals("user", latestMessage.role());
        assertEquals("Hello", latestMessage.parts().get().get(0).text().get());
    }

    @Test
    void shouldGenerateRunId_whenNotProvidedInParameters() {
        // Arrange
        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of())
                .runId(null) // Explicitly null
                .build();

        // Act
        RunContext context = new RunContext(params, "app", "user");

        // Assert
        assertNotNull(context.runId());
        assertDoesNotThrow(() -> UUID.fromString(context.runId()), "Generated runId should be a valid UUID");
    }

    @Test
    void shouldExtractLatestUserMessage_whenMultipleMessagesExist() {
        // Arrange
        UserMessage firstUserMessage = new UserMessage();
        firstUserMessage.setRole(Role.user);
        firstUserMessage.setContent("First message");

        // A non-user message in between
        BaseMessage otherMessage = new UserMessage();
        otherMessage.setRole(Role.model); // Not a user message
        otherMessage.setContent("Some other content");
        
        UserMessage latestUserMessage = new UserMessage();
        latestUserMessage.setRole(Role.user);
        latestUserMessage.setContent("Latest message");

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(firstUserMessage, otherMessage, latestUserMessage))
                .build();

        // Act
        RunContext context = new RunContext(params, "app", "user");

        // Assert
        Content latestMessage = context.latestMessage();
        assertNotNull(latestMessage);
        assertEquals("Latest message", latestMessage.parts().get().get(0).text().get());
    }

    @Test
    void shouldHaveNullLatestMessage_whenNoUserMessagesExist() {
        // Arrange
        BaseMessage assistantMessage = new UserMessage();
        assistantMessage.setRole(Role.model);
        assistantMessage.setContent("I am a model");

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(assistantMessage))
                .build();

        // Act
        RunContext context = new RunContext(params, "app", "user");

        // Assert
        assertNull(context.latestMessage());
    }

    @Test
    void shouldHaveNullLatestMessage_whenMessagesListIsEmpty() {
        // Arrange
        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of())
                .build();

        // Act
        RunContext context = new RunContext(params, "app", "user");

        // Assert
        assertNull(context.latestMessage());
    }
}
