package com.agui.adk.processor;

import com.agui.core.message.ToolMessage;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import com.agui.core.message.UserMessage;
import com.google.genai.types.FunctionResponse;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;

class MessageProcessorTest {

    private MessageProcessor messageProcessor;

    @BeforeEach
    void setUp() {
        messageProcessor = MessageProcessor.INSTANCE;
    }

    @Test
    void shouldReturnEmptyContent_whenInputsAreEmpty() {
        // Arrange
        List<ToolResult> emptyToolResults = List.of();
        List<com.agui.core.message.BaseMessage> emptyMessageBatch = List.of();

        // Act
        Optional<Content> result = messageProcessor.constructMessageToSend(emptyMessageBatch, emptyToolResults);

        // Assert
        assertTrue(result.isEmpty(), "Expected an empty Optional when both inputs are empty");
    }

    @Test
    void shouldReturnContentWithTextPart_whenOnlyUserMessageProvided() {
        // Arrange
        UserMessage userMessage = new UserMessage();
        userMessage.setRole(com.agui.core.message.Role.user);
        userMessage.setContent("Hello, world!");
        List<com.agui.core.message.BaseMessage> messageBatch = List.of(userMessage);

        // Act
        Optional<Content> result = messageProcessor.constructMessageToSend(messageBatch, List.of());

        // Assert
        assertTrue(result.isPresent(), "Expected a non-empty Optional");
        Content content = result.get();
        assertEquals("user", content.role());
        assertEquals(1, content.parts().get().size());
        assertEquals("Hello, world!", content.parts().get().get(0).text().get());
    }

    @Test
    void shouldReturnContentWithFunctionResponse_whenOnlyToolResultProvided() {
        // Arrange
        ToolMessage toolMessage = new ToolMessage();
        toolMessage.setContent("{\"status\":\"done\"}");
        ToolResult toolResult = new ToolResult("test-tool", toolMessage);
        List<ToolResult> toolResults = List.of(toolResult);

        // Act
        Optional<Content> result = messageProcessor.constructMessageToSend(List.of(), toolResults);

        // Assert
        assertTrue(result.isPresent(), "Expected a non-empty Optional");
        Content content = result.get();
        assertEquals("user", content.role());
        assertEquals(1, content.parts().get().size());
        
        assertTrue(content.parts().get().get(0).functionResponse().isPresent(), "Expected a function response part");
        FunctionResponse funcResponse = content.parts().get().get(0).functionResponse().get();
        
        assertEquals("test-tool", funcResponse.name());
        assertTrue(funcResponse.response().containsKey("status"));
        assertEquals("done", funcResponse.response().get("status"));
    }
    @Test
    void shouldReturnContentWithBothParts_whenBothToolResultAndUserMessageProvided() {
        // Arrange
        ToolMessage toolMessage = new ToolMessage();
        toolMessage.setContent("{\"status\":\"done\"}");
        ToolResult toolResult = new ToolResult("test-tool", toolMessage);
        List<ToolResult> toolResults = List.of(toolResult);

        UserMessage userMessage = new UserMessage();
        userMessage.setRole(com.agui.core.message.Role.user);
        userMessage.setContent("Is it done yet?");
        List<com.agui.core.message.BaseMessage> messageBatch = List.of(userMessage);

        // Act
        Optional<Content> result = messageProcessor.constructMessageToSend(messageBatch, toolResults);

        // Assert
        assertTrue(result.isPresent(), "Expected a non-empty Optional");
        Content content = result.get();
        assertEquals("user", content.role());
        assertEquals(2, content.parts().get().size(), "Expected two parts in the content");

        // Verify Part 1: FunctionResponse
        assertTrue(content.parts().get().get(0).functionResponse().isPresent(), "Expected the first part to be a function response");
        FunctionResponse funcResponse = content.parts().get().get(0).functionResponse().get();
        assertEquals("test-tool", funcResponse.name());
        assertEquals("done", funcResponse.response().get("status"));
        
        // Verify Part 2: Text
        assertTrue(content.parts().get().get(1).text().isPresent(), "Expected the second part to be text");
        assertEquals("Is it done yet?", content.parts().get().get(1).text().get());
    }
    
    // More tests will be added here
}
