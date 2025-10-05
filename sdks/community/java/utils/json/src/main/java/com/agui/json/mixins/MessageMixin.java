package com.agui.json.mixins;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.agui.core.message.*;


/**
 * Jackson mixin interface for configuring JSON serialization of BaseMessage and its subclasses.
 * <p>
 * MessageMixin provides Jackson annotations to enable proper polymorphic serialization and
 * deserialization of the entire agui message hierarchy. This mixin uses the message's
 * "role" property as the type discriminator to maintain type safety during JSON processing.
 * <p>
 * The mixin configures Jackson to:
 * <ul>
 * <li>Use the "role" property as the type discriminator</li>
 * <li>Map each message role to its corresponding Java class</li>
 * <li>Preserve complete type information during serialization</li>
 * <li>Reconstruct the correct message subclass during deserialization</li>
 * </ul>
 * <p>
 * Supported message types and their role mappings:
 * <ul>
 * <li>"assistant" → {@link AssistantMessage} - AI assistant responses with optional tool calls</li>
 * <li>"developer" → {@link DeveloperMessage} - Developer instructions and system context</li>
 * <li>"user" → {@link UserMessage} - User input and queries</li>
 * <li>"system" → {@link SystemMessage} - System prompts and behavioral instructions</li>
 * <li>"tool" → {@link ToolMessage} - Tool execution results and function call responses</li>
 * </ul>
 * <p>
 * This role-based type discrimination aligns with common conversational AI patterns
 * where message types are naturally distinguished by their sender role in the conversation.
 * The approach ensures that message collections can be serialized and deserialized
 * while maintaining the correct type information for each message.
 * <p>
 * The mixin enables seamless JSON serialization of message objects regardless of their
 * specific subclass, making it possible to serialize conversation histories containing
 * mixed message types and deserialize them back to their original types correctly.
 * <p>
 * This mixin is applied to BaseMessage and affects all its subclasses through Jackson's
 * inheritance mechanism, providing consistent JSON handling across the entire message
 * hierarchy without requiring modifications to the core message classes.
 * <p>
 * Example JSON output:
 * <pre>{@code
 * {
 *   "role": "assistant",
 *   "content": "Hello! How can I help you today?",
 *   "id": "msg-123",
 *   "name": "AI Assistant",
 *   "toolCalls": []
 * }
 * }</pre>
 * <p>
 * The role-based discrimination is particularly useful for conversation persistence,
 * API communication, and maintaining conversation context across different components
 * of the agui framework.
 *
 * @author Pascal Wilbrink
 */
@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,
    property = "role"
)
@JsonSubTypes({
    @JsonSubTypes.Type(value = AssistantMessage.class, name = "assistant"),
    @JsonSubTypes.Type(value = DeveloperMessage.class, name = "developer"),
    @JsonSubTypes.Type(value = UserMessage.class, name = "user"),
    @JsonSubTypes.Type(value = SystemMessage.class, name = "system"),
    @JsonSubTypes.Type(value = ToolMessage.class, name = "tool")
})
public interface MessageMixin {
}