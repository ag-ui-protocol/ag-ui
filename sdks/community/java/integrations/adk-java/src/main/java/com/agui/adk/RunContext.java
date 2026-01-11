package com.agui.adk;

import com.agui.core.agent.RunAgentParameters;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.google.genai.types.Content;
import com.google.genai.types.Part;
import org.jetbrains.annotations.Nullable;

import java.util.List;
import java.util.UUID;

record RunContext(String appName, String userId, String sessionId, String runId, Content latestMessage) {

    RunContext(RunAgentParameters parameters, String appName, String userId) {
        this(appName, userId, parameters.getThreadId(), extractRunId(parameters), extractContentFromLatestMessage(parameters));
    }

    @Nullable
    private static Content extractContentFromLatestMessage(RunAgentParameters parameters) {
        List<BaseMessage> messages = parameters.getMessages();
        if (messages == null || messages.isEmpty()) {
            return null;
        }
        return messages.stream()
                .filter(m -> m.getRole() == Role.user)
                .reduce((first, second) -> second) // Get the last user message
                .map(latestUserMessage -> Content.builder()
                        .role("user")
                        .parts(List.of(Part.builder().text(latestUserMessage.getContent()).build()))
                        .build())
                .orElse(null);
    }

    private static String extractRunId(RunAgentParameters parameters) {
        return parameters.getRunId() != null ? parameters.getRunId() : UUID.randomUUID().toString();
    }

}
