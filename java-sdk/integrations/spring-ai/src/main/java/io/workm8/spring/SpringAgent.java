package io.workm8.spring;

import io.workm8.agui.client.AbstractAgent;
import io.workm8.agui.event.*;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.input.RunAgentInput;
import io.workm8.agui.state.State;
import org.springframework.ai.chat.messages.*;
import org.springframework.ai.chat.model.ChatModel;

import java.time.LocalDateTime;
import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

import static java.util.Arrays.asList;
import static java.util.Collections.emptyList;

public class SpringAgent extends AbstractAgent {

    private final ChatModel chatModel;

    public SpringAgent(
        final String agentId,
        final String description,
        final String threadId,
        final List<BaseMessage> messages,
        final ChatModel chatModel,
        final State state,
        final boolean debug
    ) {
        super(agentId, description, threadId, messages, state, debug);

        this.chatModel = chatModel;
    }

    @Override
    protected CompletableFuture<Void> run(RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        var threadId = Objects.nonNull(input.threadId()) ? input.threadId() : UUID.randomUUID().toString();
        var runId = Objects.nonNull(input.runId()) ? input.runId() : UUID.randomUUID().toString();

        eventHandler.accept(generateRunStartedEvent(input, runId, threadId));

        CompletableFuture<Void> future = new CompletableFuture<>();

        var messageId = UUID.randomUUID().toString();

        StringBuilder message = new StringBuilder();

        this.chatModel.stream(this.convertToSpringMessages(input.messages()).toArray(new Message[0]))
            .doFirst(() -> {
                var event = new TextMessageStartEvent();
                event.setRole("assistant");
                event.setMessageId(messageId);
                event.setTimestamp(LocalDateTime.now().getNano());
                eventHandler.accept(event);
            })
            .doOnNext((res) -> {
                if (Objects.nonNull(res) && !res.isEmpty()) {
                    var contentEvent = new TextMessageContentEvent();
                    contentEvent.setTimestamp(LocalDateTime.now().getNano());
                    contentEvent.setDelta(res);
                    contentEvent.setMessageId(messageId);
                    eventHandler.accept(contentEvent);
                    message.append(res);
                }
            })
            .doOnError(future::completeExceptionally)
            .doOnCancel(() -> future.completeExceptionally(new RuntimeException("Cancelled")))
            .doOnComplete(() -> {
                var textMessageContentEvent = new TextMessageContentEvent();
                textMessageContentEvent.setDelta(message.toString());
                textMessageContentEvent.setMessageId(messageId);
                textMessageContentEvent.setTimestamp(LocalDateTime.now().getNano());

                eventHandler.accept(textMessageContentEvent);

                var textMessageEndEvent = new TextMessageEndEvent();
                textMessageEndEvent.setTimestamp(LocalDateTime.now().getNano());
                textMessageEndEvent.setMessageId(messageId);
                eventHandler.accept(textMessageEndEvent);

                var assistantMessage = new io.workm8.agui.message.AssistantMessage();
                assistantMessage.setId(messageId);
                assistantMessage.setContent(message.toString());
                assistantMessage.setName("");
                this.addMessage(assistantMessage);

                var snapshotEvent = new MessagesSnapshotEvent();
                snapshotEvent.setMessages(this.messages);
                snapshotEvent.setTimestamp(LocalDateTime.now().getNano());

                eventHandler.accept(snapshotEvent);

                var event = new RunFinishedEvent();

                event.setRunId(runId);
                event.setResult(message.toString());
                event.setThreadId(threadId);

                event.setTimestamp(LocalDateTime.now().getNano());
                eventHandler.accept(event);

                future.complete(null);

            })
            .subscribe();

        return future;
    }

    private List<AbstractMessage> convertToSpringMessages(final List<BaseMessage> messages) {
        return messages.stream().map((message) -> {
            switch (message.getRole()) {
                case "assistant":
                    io.workm8.agui.message.AssistantMessage mappedAssistantMessage = (io.workm8.agui.message.AssistantMessage)message;

                    return new AssistantMessage(
                        mappedAssistantMessage.getContent(),
                        Map.of(
                            "id",
                            Objects.nonNull(mappedAssistantMessage.getId()) ? mappedAssistantMessage.getId() : UUID.randomUUID().toString(),
                            "name",
                            Objects.nonNull(mappedAssistantMessage.getName()) ? mappedAssistantMessage.getName() : ""
                        ),
                        Objects.isNull(mappedAssistantMessage.getToolCalls())
                            ? emptyList()
                            : mappedAssistantMessage.getToolCalls().stream().map(toolCall -> new AssistantMessage.ToolCall(
                                Objects.nonNull(toolCall.id()) ? toolCall.id() : UUID.randomUUID().toString(),
                                toolCall.type(),
                                toolCall.function().name(),
                                toolCall.function().arguments()
                            )).toList()
                    );
                case "user":
                default:
                    io.workm8.agui.message.UserMessage mappedUserMessage = (io.workm8.agui.message.UserMessage)message;

                    return UserMessage.builder()
                        .text(mappedUserMessage.getContent())
                        .metadata(
                            Map.of(
                                "id",
                                Objects.nonNull(mappedUserMessage.getId()) ? mappedUserMessage.getId() : UUID.randomUUID().toString(),
                                "name",
                                Objects.nonNull(mappedUserMessage.getName()) ? mappedUserMessage.getName() : ""
                            )
                        ).build();
                case "system":
                    io.workm8.agui.message.SystemMessage mappedSystemMessage = (io.workm8.agui.message.SystemMessage)message;

                    return SystemMessage.builder()
                        .text(mappedSystemMessage.getContent())
                        .metadata(
                            Map.of(
                                "id",
                                Objects.nonNull(mappedSystemMessage.getId()) ? mappedSystemMessage.getId() : UUID.randomUUID().toString(),
                                "name",
                                Objects.nonNull(mappedSystemMessage.getName()) ? mappedSystemMessage.getName() : ""
                            )
                        ).build();
                case "developer":
                    io.workm8.agui.message.DeveloperMessage mappedDeveloperMessage = (io.workm8.agui.message.DeveloperMessage)message;

                    return UserMessage.builder()
                        .text(mappedDeveloperMessage.getContent())
                        .metadata(
                            Map.of(
                                "id",
                                Objects.nonNull(mappedDeveloperMessage.getId()) ? mappedDeveloperMessage.getId() : UUID.randomUUID().toString(),
                                "name",
                                Objects.nonNull(mappedDeveloperMessage.getName()) ? mappedDeveloperMessage.getName() : ""
                            )
                        ).build();
                case "tool":
                    io.workm8.agui.message.ToolMessage mappedToolMessage = (io.workm8.agui.message.ToolMessage)message;

                    return new ToolResponseMessage(
                        asList(
                            new ToolResponseMessage.ToolResponse(mappedToolMessage.getToolCallId(), mappedToolMessage.getName(), Objects.nonNull(mappedToolMessage.getError()) ? mappedToolMessage.getError() : mappedToolMessage.getContent())
                        ),
                        Map.of(
                            "id",
                            Objects.nonNull(mappedToolMessage.getId()) ? mappedToolMessage.getId() : UUID.randomUUID().toString(),
                            "name",
                            Objects.nonNull(mappedToolMessage.getName()) ? mappedToolMessage.getName() : ""
                        )
                    );
            }
        }).toList();
    }

    private RunStartedEvent generateRunStartedEvent(final RunAgentInput input, String runId, String threadId) {
        var event = new RunStartedEvent();
        event.setThreadId(threadId);
        event.setRunId(runId);
        event.setTimestamp(LocalDateTime.now().getNano());

        return event;
    }
}
