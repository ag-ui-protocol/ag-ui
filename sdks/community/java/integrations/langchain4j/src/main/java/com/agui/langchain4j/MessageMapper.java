package com.agui.langchain4j;

import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.data.message.TextContent;
import com.agui.core.message.Role;

/**
 * Utility class for converting agui message formats to LangChain4j message formats.
 * <p>
 * MessageMapper provides bidirectional conversion between the agui message hierarchy
 * and LangChain4j's message system, enabling seamless integration between the two frameworks.
 * The mapper handles different message types including user messages, assistant messages,
 * system messages, and tool messages while preserving all relevant metadata and content.
 * <p>
 * Supported message type mappings:
 * <ul>
 * <li>UserMessage ↔ LangChain4j UserMessage with TextContent</li>
 * <li>AssistantMessage ↔ LangChain4j AiMessage with tool execution requests</li>
 * <li>SystemMessage ↔ LangChain4j SystemMessage</li>
 * <li>ToolMessage ↔ LangChain4j ToolExecutionResultMessage</li>
 * </ul>
 * <p>
 * The mapper preserves important message attributes such as:
 * <ul>
 * <li>Message content and text</li>
 * <li>Sender names and roles</li>
 * <li>Tool call information and execution requests</li>
 * <li>Tool call IDs and arguments</li>
 * </ul>
 * <p>
 * This class is stateless and thread-safe, making it suitable for use in
 * concurrent environments and as a singleton or utility class.
 *
 * @author Pascal Wilbrink
 */
public class MessageMapper {

    /**
     * Converts an agui BaseMessage to the corresponding LangChain4j ChatMessage.
     * <p>
     * This method acts as a dispatcher, examining the message role to determine
     * the appropriate conversion method. It handles all supported message types
     * and delegates to specific conversion methods based on the message role.
     * <p>
     * Supported roles and their mappings:
     * <ul>
     * <li>"assistant" → AiMessage via {@link #toLangchainAiMessage}</li>
     * <li>"system" → SystemMessage via {@link #toLangchainSystemMessage}</li>
     * <li>"tool" → ToolExecutionResultMessage via {@link #toLangchainToolMessage}</li>
     * <li>Default/Other → UserMessage via {@link #toLangchainUserMessage}</li>
     * </ul>
     *
     * @param message the agui BaseMessage to convert
     * @return the corresponding LangChain4j ChatMessage
     * @throws ClassCastException if the message cannot be cast to the expected type
     *                           based on its role
     */
    public dev.langchain4j.data.message.ChatMessage toLangchainMessage(final com.agui.core.message.BaseMessage message) {
        switch (message.getRole()) {
            case assistant -> {
                return this.toLangchainAiMessage((com.agui.core.message.AssistantMessage) message);
            }
            case system -> {
                return this.toLangchainSystemMessage((com.agui.core.message.SystemMessage) message);
            }
            case tool -> {
                return this.toLangchainToolMessage((com.agui.core.message.ToolMessage) message);
            }
            default -> {
                return this.toLangchainUserMessage((com.agui.core.message.UserMessage) message);
            }
        }
    }

    /**
     * Converts an agui ToolMessage to a LangChain4j ToolExecutionResultMessage.
     * <p>
     * This method creates a LangChain4j ToolExecutionResultMessage that represents
     * the result of a tool execution. It preserves the tool call ID, tool name,
     * and the content returned by the tool execution.
     * <p>
     * The conversion maintains the association between the tool call and its result,
     * which is essential for multi-turn conversations involving function calling.
     *
     * @param message the agui ToolMessage containing tool execution result
     * @return a LangChain4j ToolExecutionResultMessage with the tool call ID,
     *         name, and execution result content
     */
    public dev.langchain4j.data.message.ToolExecutionResultMessage toLangchainToolMessage(final com.agui.core.message.ToolMessage message) {
        return dev.langchain4j.data.message.ToolExecutionResultMessage.from(
                message.getToolCallId(),
                message.getName(),
                message.getContent()
        );
    }

    /**
     * Converts an agui UserMessage to a LangChain4j UserMessage.
     * <p>
     * This method creates a LangChain4j UserMessage with TextContent, preserving
     * the user's name (if available) and message content. The content is wrapped
     * in a TextContent object as required by LangChain4j's message structure.
     * <p>
     * The conversion handles both named and anonymous user messages, maintaining
     * user identity information when available for better conversation context.
     *
     * @param message the agui UserMessage to convert
     * @return a LangChain4j UserMessage with the user's name and text content
     */
    public dev.langchain4j.data.message.UserMessage toLangchainUserMessage(final com.agui.core.message.UserMessage message) {
        return dev.langchain4j.data.message.UserMessage.builder()
                .name(message.getName())
                .addContent(TextContent.from(message.getContent()))
                .build();
    }

    /**
     * Converts an agui SystemMessage to a LangChain4j SystemMessage.
     * <p>
     * This method creates a LangChain4j SystemMessage that contains system-level
     * instructions or context. System messages are typically used to set the
     * behavior, role, or context for the AI assistant at the beginning of
     * a conversation.
     * <p>
     * The conversion is straightforward as both frameworks have similar concepts
     * for system-level messaging, preserving the instructional content exactly.
     *
     * @param message the agui SystemMessage containing system instructions
     * @return a LangChain4j SystemMessage with the system content
     */
    public dev.langchain4j.data.message.SystemMessage toLangchainSystemMessage(final com.agui.core.message.SystemMessage message) {
        return dev.langchain4j.data.message.SystemMessage.systemMessage(message.getContent());
    }

    /**
     * Converts an agui AssistantMessage to a LangChain4j AiMessage.
     * <p>
     * This method creates a LangChain4j AiMessage that represents a response from
     * the AI assistant. It handles both regular text responses and messages that
     * contain tool execution requests (function calls).
     * <p>
     * The conversion process:
     * <ul>
     * <li>Maps message text content directly</li>
     * <li>Converts agui tool calls to LangChain4j ToolExecutionRequests</li>
     * <li>Preserves tool call IDs, function names, and arguments</li>
     * <li>Maintains the relationship between message content and tool calls</li>
     * </ul>
     * <p>
     * Tool calls are converted from agui's ToolCall format to LangChain4j's
     * ToolExecutionRequest format, ensuring compatibility with LangChain4j's
     * function calling mechanisms.
     *
     * @param message the agui AssistantMessage to convert, potentially containing
     *               text content and tool calls
     * @return a LangChain4j AiMessage with text content and any tool execution
     *         requests converted from the original tool calls
     */
    public dev.langchain4j.data.message.AiMessage toLangchainAiMessage(final com.agui.core.message.AssistantMessage message) {
        return dev.langchain4j.data.message.AiMessage.builder()
                .toolExecutionRequests(
                        message.getToolCalls().stream().map((toolCall -> ToolExecutionRequest.builder()
                                .id(toolCall.id())
                                .arguments(toolCall.function().arguments())
                                .name(toolCall.function().name())
                                .build())).toList()
                )
                .text(message.getContent())
                .build();
    }

}