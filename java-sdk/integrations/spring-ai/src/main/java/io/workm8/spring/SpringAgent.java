package io.workm8.spring;

import io.workm8.agui.client.AbstractAgent;
import io.workm8.agui.client.stream.IEventStream;
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
    protected void run(RunAgentInput input, IEventStream<BaseEvent> stream) {
        var threadId = Objects.nonNull(input.threadId()) ? input.threadId() : UUID.randomUUID().toString();
        var runId = Objects.nonNull(input.runId()) ? input.runId() : UUID.randomUUID().toString();

        // Emit run started event
        stream.next(generateRunStartedEvent(input, runId, threadId));

        var messageId = UUID.randomUUID().toString();
        StringBuilder message = new StringBuilder();

        try {
            this.chatModel.stream(this.convertToSpringMessages(input.messages()).toArray(new Message[0]))
                .doFirst(() -> {
                    if (!stream.isCancelled()) {
                        var event = new TextMessageStartEvent();
                        event.setRole("assistant");
                        event.setMessageId(messageId);
                        event.setTimestamp(LocalDateTime.now().getNano());
                        stream.next(event);
                    }
                })
                .doOnNext((res) -> {
                    if (!stream.isCancelled() && Objects.nonNull(res) && !res.isEmpty()) {
                        var contentEvent = new TextMessageContentEvent();
                        contentEvent.setTimestamp(LocalDateTime.now().getNano());
                        contentEvent.setDelta(res);
                        contentEvent.setMessageId(messageId);
                        stream.next(contentEvent);
                        message.append(res);
                    }
                })
                .doOnError(error -> {
                    if (!stream.isCancelled()) {
                        stream.error(error);
                    }
                })
                .doOnCancel(() -> {
                    if (!stream.isCancelled()) {
                        stream.error(new RuntimeException("Cancelled"));
                    }
                })
                .doOnComplete(() -> {
                    if (!stream.isCancelled()) {
                        // Send final content event with full message
                        /*
                        var textMessageContentEvent = new TextMessageContentEvent();
                        textMessageContentEvent.setDelta(message.toString());
                        textMessageContentEvent.setMessageId(messageId);
                        textMessageContentEvent.setTimestamp(LocalDateTime.now().getNano());
                        stream.next(textMessageContentEvent);
*/
                        // Send message end event
                        var textMessageEndEvent = new TextMessageEndEvent();
                        textMessageEndEvent.setTimestamp(LocalDateTime.now().getNano());
                        textMessageEndEvent.setMessageId(messageId);
                        stream.next(textMessageEndEvent);

                        // Add message to agent's message list
                        var assistantMessage = new io.workm8.agui.message.AssistantMessage();
                        assistantMessage.setId(messageId);
                        assistantMessage.setContent(message.toString());
                        assistantMessage.setName("");
//                        this.addMessage(assistantMessage);

                        // Send messages snapshot event
                        var snapshotEvent = new MessagesSnapshotEvent();
                        snapshotEvent.setMessages(this.messages);
                        snapshotEvent.setTimestamp(LocalDateTime.now().getNano());
                        stream.next(snapshotEvent);

                        // Send run finished event
                        var runFinishedEvent = new RunFinishedEvent();
                        runFinishedEvent.setRunId(runId);
                        runFinishedEvent.setResult(message.toString());
                        runFinishedEvent.setThreadId(threadId);
                        runFinishedEvent.setTimestamp(LocalDateTime.now().getNano());
                        stream.next(runFinishedEvent);

                        // Complete the stream
                        stream.complete();
                    }
            })
            .subscribe();
        } catch (Exception e) {
            stream.error(e);
        }
    }

    // Remove the old run method signature or keep it for backward compatibility
    @Deprecated
    protected CompletableFuture<Void> run(RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        CompletableFuture<Void> future = new CompletableFuture<>();

        // Create a simple stream that delegates to the eventHandler
        IEventStream<BaseEvent> stream = new IEventStream<BaseEvent>() {
            @Override
            public void next(BaseEvent event) {
                eventHandler.accept(event);
            }

            @Override
            public void error(Throwable error) {
                future.completeExceptionally(error);
            }

            @Override
            public void complete() {
                future.complete(null);
            }

            @Override
            public boolean isCancelled() {
                return future.isCancelled();
            }

            @Override
            public void cancel() {
                future.cancel(true);
            }
        };

        // Call the new run method
        run(input, stream);

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