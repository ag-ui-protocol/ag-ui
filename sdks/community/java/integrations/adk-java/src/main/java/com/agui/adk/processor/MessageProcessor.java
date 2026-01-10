package com.agui.adk.processor;

import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionResponse;
import com.google.genai.types.Part;
import com.google.gson.Gson;
import com.google.gson.reflect.TypeToken;
import org.jetbrains.annotations.NotNull;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.function.Predicate;
import java.util.stream.Stream;

public enum MessageProcessor {

    INSTANCE;

    private static final Predicate<BaseMessage> IS_TOOL_MESSAGE = message -> message.getRole() == Role.tool;
    private static final Predicate<BaseMessage> IS_NOT_TOOL_MESSAGE = IS_TOOL_MESSAGE.negate();

    private final Gson gson = new Gson();

    public List<MessageChunk> groupMessagesIntoChunks(List<BaseMessage> messages) {
        if (messages.isEmpty()) {
            return List.of();
        }

        List<MessageChunk> result = new ArrayList<>();
        List<BaseMessage> remainingMessages = messages;

        while (!remainingMessages.isEmpty()) {
            MessageChunk messageChunk = (remainingMessages.get(0).getRole() == Role.tool)
                    ? createToolLedChunk(remainingMessages)
                    : createUserLedChunk(remainingMessages);
            
            result.add(messageChunk);
            
            int processedCount = messageChunk.toolMessages().size() + messageChunk.userSystemMessages().size();
            remainingMessages = remainingMessages.subList(processedCount, remainingMessages.size());
        }
        
        return result;
    }

    private static MessageChunk createToolLedChunk(List<BaseMessage> messages) {
        List<BaseMessage> toolChunk = findChunk(messages, IS_TOOL_MESSAGE);
        List<BaseMessage> messagesAfterTools = messages.subList(toolChunk.size(), messages.size());
        List<BaseMessage> userSystemChunk = findChunk(messagesAfterTools, IS_NOT_TOOL_MESSAGE);
        return new MessageChunk(toolChunk, userSystemChunk);
    }

    private static MessageChunk createUserLedChunk(List<BaseMessage> messages) {
        List<BaseMessage> userSystemChunk = findChunk(messages, IS_NOT_TOOL_MESSAGE);
        return MessageChunk.fromUserSystemChunk(userSystemChunk);
    }
    
    private static List<BaseMessage> findChunk(List<BaseMessage> messages, Predicate<BaseMessage> predicate) {
        return messages.stream()
                .takeWhile(predicate)
                .toList();
    }

    public Optional<Content> constructMessageToSend(List<BaseMessage> messageBatch, List<ToolResult> toolResults) {
        List<Part> toolParts = createToolParts(toolResults);
        List<Part> userParts = createUserParts(messageBatch);
        List<Part> parts = Stream.of(toolParts, userParts)
                .filter(list -> !list.isEmpty())
                .flatMap(List::stream)
                .toList();

        return Optional.of(parts)
                .filter (items -> !items.isEmpty())
                .map(items -> Content.builder()
                        .role("user")
                        .parts(items)
                        .build());
    }

    @NotNull
    private static List<Part> createUserParts(List<BaseMessage> messageBatch) {
        return messageBatch.stream()
                .filter(message -> message.getRole() == Role.user && message.getContent() != null && !message.getContent().isEmpty())
                .reduce((first, second) -> second) // Get the last user message
                .map(latestUserMessage -> Part.fromText(latestUserMessage.getContent()))
                .map(List::of) // If present, wraps the Part in a List.
                .orElse(List.of());
    }

    @NotNull
    private List<Part> createToolParts(List<ToolResult> toolResults) {
        return Optional.ofNullable(toolResults)
                .orElse(List.of())
                .stream()
                .map(toolResult -> {
                    Map<String, Object> responseMap = this.gson.fromJson(toolResult.message().getContent(),
                            new TypeToken<Map<String, Object>>() {
                            }.getType());
                    return buildPart(toolResult.toolName(), responseMap);
                })
                .toList();
    }

    private static Part buildPart(String toolName, Map<String, Object> responseMap) {
        return Part.builder().functionResponse(createFunctionResponse(toolName, responseMap)).build();
    }

    private static FunctionResponse createFunctionResponse(String toolName, Map<String, Object> responseMap) {
        return FunctionResponse.builder()
                .name(toolName)
                .response(responseMap)
                .build();
    }
}