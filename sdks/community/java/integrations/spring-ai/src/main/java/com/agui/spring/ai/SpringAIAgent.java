package com.agui.spring.ai;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;
import com.agui.core.exception.AGUIException;
import com.agui.core.function.FunctionCall;
import com.agui.core.message.*;
import com.agui.core.state.State;
import com.agui.core.tool.ToolCall;
import com.agui.server.LocalAgent;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.client.advisor.PromptChatMemoryAdvisor;
import org.springframework.ai.chat.client.advisor.api.Advisor;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.model.ChatModel;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.chat.prompt.Prompt;
import org.springframework.ai.tool.ToolCallback;
import org.springframework.util.StringUtils;

import java.util.*;
import java.util.function.Function;

import static com.agui.server.EventFactory.*;
import static java.util.stream.Collectors.toList;

/**
 * A concrete implementation of {@link LocalAgent} that integrates with Spring AI framework
 * to provide AI-powered agent capabilities.
 *
 * This agent leverages Spring AI's ChatClient to process messages and interact with
 * various chat models. It supports tools, advisors, chat memory, and streaming responses.
 * The agent handles the complete lifecycle of chat interactions including tool calls,
 * memory management, and event emission for real-time updates.
 *
 * Key features:
 * <ul>
 * <li>Integration with Spring AI ChatClient and ChatModel</li>
 * <li>Support for tool callbacks and function calling</li>
 * <li>Chat memory management for conversation persistence</li>
 * <li>Advisor pattern support for extending functionality</li>
 * <li>Streaming response handling with real-time events</li>
 * <li>Automatic tool mapping from AG-UI tools to Spring AI tools</li>
 * </ul>
 *
 * @author Pascal Wilbrink
 * @since 1.0
 */
public class SpringAIAgent extends LocalAgent {

    /**
     * The Spring AI ChatClient used for processing chat requests and responses.
     */
    private final ChatClient chatClient;

    /**
     * Mapper utility for converting AG-UI tools to Spring AI ToolCallback instances.
     */
    private final ToolMapper toolMapper;

    /**
     * List of Spring AI advisors that modify or enhance chat behavior.
     */
    private final List<Advisor> advisors;

    /**
     * List of Spring AI tool callbacks for function calling capabilities.
     */
    private final List<ToolCallback> toolCallbacks;

    /**
     * Chat memory implementation for maintaining conversation history.
     */
    private final ChatMemory chatMemory;

    /**
     * List of Spring AI tools
     */
    private final List<Object> tools;

    /**
     * Protected constructor that initializes the SpringAIAgent using the builder pattern.
     *
     * @param builder the Builder instance containing all configuration parameters
     * @throws AGUIException if the parent LocalAgent constructor validation fails
     */
    protected SpringAIAgent(
        Builder builder
    ) throws AGUIException {
        super(
            builder.agentId,
            builder.state,
            builder.systemMessageProvider,
            builder.systemMessage,
            builder.messages
        );

        this.chatClient = ChatClient.builder(builder.chatModel).build();

        this.chatMemory = builder.chatMemory;

        this.advisors = builder.advisors;

        this.toolCallbacks = builder.toolCallbacks;
        this.tools = builder.tools;

        this.toolMapper = new ToolMapper();
    }

    /**
     * {@inheritDoc}
     *
     * Executes the agent by processing the latest user message through Spring AI's ChatClient.
     * The method handles the complete chat lifecycle including:
     * <ul>
     * <li>Extracting the user message from input</li>
     * <li>Setting up the chat request with tools, advisors, and memory</li>
     * <li>Streaming the response and emitting appropriate events</li>
     * <li>Handling tool calls and deferred events</li>
     * <li>Managing conversation memory</li>
     * </ul>
     *
     * Events are emitted throughout the process to provide real-time updates to subscribers.
     */
    protected void run(RunAgentInput input, AgentSubscriber subscriber) {
        var messageId = UUID.randomUUID().toString();
        var threadId = input.threadId();
        var runId = input.runId();
        var state = input.state();

        input.messages().forEach((message) -> {
            if (messages.stream().filter((m) -> m.equals(message)).findAny().isEmpty()) {
                messages.add(message);
            }
        });

        String content;

        try {
            var userMessage = this.getLatestUserMessage(messages);
            content = userMessage.getContent();
        } catch (AGUIException e) {
            this.emitEvent(runErrorEvent(e.getMessage()), subscriber);
            return;
        }

        this.emitEvent(
            runStartedEvent(threadId, runId),
            subscriber
        );

        this.emitEvent(
            textMessageStartEvent(messageId, "assistant"),
            subscriber
        );

        final List<BaseEvent> deferredEvents = new ArrayList<>();

        var assistantMessage = new AssistantMessage();
        assistantMessage.setId(messageId);
        assistantMessage.setName(this.agentId);

        try {
            getChatRequest(input, content, messageId, deferredEvents, this.createSystemMessage(state, input.context()), subscriber)
                .stream()
                .chatResponse()
                .subscribe(
                    evt -> onEvent(subscriber, evt, assistantMessage, messageId, deferredEvents),
                    err -> this.emitEvent(runErrorEvent(err.getMessage()), subscriber),
                    () -> onComplete(input, assistantMessage, subscriber, messageId, deferredEvents)
                );
        } catch (AGUIException e) {
            this.emitEvent(runErrorEvent(e.getMessage()), subscriber);
        }
    }

    /**
     * Handles individual chat response events from the streaming response.
     *
     * This method processes each chunk of the streaming response and emits
     * text message content events when the response contains actual text content.
     *
     * @param subscriber the event subscriber to notify
     * @param evt the chat response event from Spring AI
     * @param messageId the unique identifier for the current message
     * @param deferredEvents Events that will be deferred and emitted later
     */
    private void onEvent(AgentSubscriber subscriber, ChatResponse evt, AssistantMessage assistantMessage, String messageId, List<BaseEvent> deferredEvents) {
        if (evt.hasToolCalls()) {
            assistantMessage.setToolCalls(new ArrayList<>());
            evt.getResult().getOutput().getToolCalls()
                .forEach(toolCall -> {
                    var call = new ToolCall(toolCall.id(), "function", new FunctionCall(toolCall.name(), toolCall.arguments()));

                    assistantMessage.getToolCalls().add(call);

                    var toolCallId = toolCall.id();
                    deferredEvents.add(toolCallStartEvent(messageId, toolCall.name(), toolCallId));
                    deferredEvents.add(toolCallArgsEvent(toolCall.arguments(), toolCallId));
                    deferredEvents.add(toolCallEndEvent(toolCallId));

                    subscriber.onNewToolCall(call);
                });
        }
        var content = evt.getResult().getOutput().getText();

        if (StringUtils.hasText(content)) {
            this.emitEvent(
                textMessageContentEvent(messageId, content),
                subscriber
            );

            assistantMessage.setContent(
                assistantMessage.getContent() + " " + content
            );
        }
    }

    /**
     * Handles the completion of the chat response stream.
     * This method is called when the streaming response is complete and handles:
     * <ul>
     * <li>Emitting the text message end event</li>
     * <li>Processing any deferred tool call events</li>
     * <li>Emitting the run finished event</li>
     * <li>Finalizing the agent run with updated state</li>
     * </ul>
     *
     * @param input the original run input parameters
     * @param subscriber the event subscriber to notify
     * @param messageId the unique identifier for the current message
     * @param deferredEvents list of tool call events to process after message completion
     */
    private void onComplete(RunAgentInput input, AssistantMessage assistantMessage, AgentSubscriber subscriber, String messageId, List<BaseEvent> deferredEvents) {
        this.emitEvent(textMessageEndEvent(messageId), subscriber);

        deferredEvents.forEach(deferredEvent -> {
            this.emitEvent(deferredEvent, subscriber);

        });

        subscriber.onNewMessage(assistantMessage);

        this.emitEvent(runFinishedEvent(input.threadId(), input.runId()), subscriber);
        subscriber.onRunFinalized(new AgentSubscriberParams(input.messages(), state, this, input));
    }

    /**
     * Constructs and configures the Spring AI ChatClient request specification.
     *
     * This method builds a complete chat request by combining:
     * <ul>
     * <li>The user message content and system message</li>
     * <li>Available tools converted to Spring AI ToolCallbacks</li>
     * <li>Configured advisors for behavior modification</li>
     * <li>Chat memory for conversation persistence</li>
     * </ul>
     *
     * @param input the run input containing messages, tools, and context
     * @param content the user message content to send
     * @param messageId unique identifier for the current message
     * @param deferredEvents list to collect events for later processing
     * @param systemMessage the formatted system message including state and context
     * @return configured ChatClient request specification ready for execution
     */
    private ChatClient.ChatClientRequestSpec getChatRequest(RunAgentInput input, String content, String messageId, List<BaseEvent> deferredEvents, SystemMessage systemMessage, AgentSubscriber subscriber) throws AGUIException {
        ChatClient.ChatClientRequestSpec chatRequest = this.chatClient.prompt(
            Prompt
                .builder()
                .content(content)
                .build()
            )
            .system(systemMessage.getContent()
        );

        if (!this.tools.isEmpty()) {
            try {
                chatRequest = chatRequest.tools(this.tools.toArray(new Object[0]));
            } catch (RuntimeException e) {
                throw new AGUIException("Could not add tools", e);
            }
        }

        if (!input.tools().isEmpty()) {
            try {
                chatRequest = chatRequest.toolCallbacks(
                    input.tools()
                        .stream()
                        .map((tool) -> this.toolMapper.toSpringTool(
                            tool,
                            messageId,
                            deferredEvents::add
                        )).toList()
                );
            } catch (RuntimeException e) {
                throw new AGUIException("Could not add Tools", e);
            }
        }

        if (!this.toolCallbacks.isEmpty()) {
            try {
                chatRequest = chatRequest.toolCallbacks(
                    this.toolCallbacks
                        .stream()
                        .map(toolCallback -> new AgUiFunctionToolCallback(toolCallback, (AgUiToolCallbackParams params) -> {
                            var toolCallId = UUID.randomUUID().toString();
                            deferredEvents.add(toolCallStartEvent(messageId, toolCallback.getToolDefinition().name(), toolCallId));
                            deferredEvents.add(toolCallArgsEvent(params.arguments(), toolCallId));
                            deferredEvents.add(toolCallEndEvent(toolCallId));
                            deferredEvents.add(toolCallResultEvent(toolCallId, params.result(), messageId, Role.tool));


                        }))
                        .collect(toList())
                );
            } catch (RuntimeException e) {
                throw new AGUIException("Could not add Tool Callbacks", e);
            }
        }

        if (!this.advisors.isEmpty()) {
            try {
                chatRequest = chatRequest.advisors(this.advisors);
            } catch (RuntimeException e) {
                throw new AGUIException("Could not add advisors", e);
            }
        }

        if (Objects.nonNull(this.chatMemory)) {
            try {
                chatRequest.advisors(
                    PromptChatMemoryAdvisor.builder(chatMemory).build()
                );

                chatRequest.advisors(a -> a.param(ChatMemory.CONVERSATION_ID, input.threadId()));
            } catch (RuntimeException e) {
                throw new AGUIException("Could not add chat memory", e);
            }
        }

        return chatRequest;
    }

    /**
     * Creates a new Builder instance for constructing SpringAIAgent instances.
     *
     * @return a new Builder instance
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builder class for constructing SpringAIAgent instances using the builder pattern.
     *
     * This builder provides a fluent API for configuring all aspects of the SpringAIAgent
     * including the chat model, advisors, tools, memory, and agent-specific settings.
     * The builder validates that required components are provided before creating the agent.
     */
    public static class Builder {

        /**
         * The Spring AI ChatModel to use for processing chat requests.
         */
        private ChatModel chatModel;

        /**
         * List of Spring AI advisors to apply to chat requests.
         */
        private final List<Advisor> advisors = new ArrayList<>();

        /**
         * List of Spring AI tool callbacks for function calling.
         */
        private final List<ToolCallback> toolCallbacks = new ArrayList<>();

        /**
         * List of Spring AI tools for function calling.
         */
        private final List<Object> tools = new ArrayList<>();

        /**
         * Unique identifier for the agent being built.
         */
        private String agentId;

        /**
         * Initial state for the agent being built.
         */
        private State state;

        /**
         * Static system message content for the agent.
         */
        private String systemMessage;

        /**
         * Dynamic system message provider function.
         */
        private Function<LocalAgent, String> systemMessageProvider;

        /**
         * Chat memory implementation for conversation persistence.
         */
        private ChatMemory chatMemory;

        /**
         * Initial messages for the agent
         */
        private List<BaseMessage> messages = new ArrayList<>();

        /**
         * Sets the ChatModel for the agent.
         *
         * @param chatModel the Spring AI ChatModel to use
         * @return this builder instance for method chaining
         */
        public Builder chatModel(final ChatModel chatModel) {
            this.chatModel = chatModel;

            return this;
        }

        /**
         * Adds multiple advisors to the agent configuration.
         *
         * @param advisors list of Spring AI advisors to add
         * @return this builder instance for method chaining
         */
        public Builder advisors(final List<Advisor> advisors) {
            this.advisors.addAll(advisors);

            return this;
        }

        /**
         * Adds a single advisor to the agent configuration.
         *
         * @param advisor the Spring AI advisor to add
         * @return this builder instance for method chaining
         */
        public Builder advisor(final Advisor advisor) {
            this.advisors.add(advisor);

            return this;
        }

        /**
         * Adds multiple tools to the agent configuration.
         *
         * @param tools list of Spring AI tools to add
         * @return this builder instance for method chaining
         */
        public Builder tools(final List<Object> tools) {
            this.tools.addAll(tools);

            return this;
        }

        /**
         * Adds a single tool to the agent configuration
         *
         * @param tool the Spring AI tool to add
         * @return this builder instance for method chaining
         */
        public Builder tool(final Object tool) {
            this.tools.add(tool);

            return this;
        }

        /**
         * Sets the unique identifier for the agent.
         *
         * @param agentId the unique agent identifier
         * @return this builder instance for method chaining
         */
        public Builder agentId(final String agentId) {
            this.agentId = agentId;

            return this;
        }

        /**
         * Sets the initial state for the agent.
         *
         * @param state the initial agent state
         * @return this builder instance for method chaining
         */
        public Builder state(final State state) {
            this.state = state;

            return this;
        }

        /**
         * Adds multiple tool callbacks to the agent configuration.
         *
         * @param toolCallbacks list of Spring AI tool callbacks to add
         * @return this builder instance for method chaining
         */
        public Builder toolCallbacks(final List<ToolCallback> toolCallbacks) {
            this.toolCallbacks.addAll(toolCallbacks);

            return this;
        }

        /**
         * Adds a single tool callback to the agent configuration.
         *
         * @param toolCallback the Spring AI tool callback to add
         * @return this builder instance for method chaining
         */
        public Builder toolCallback(final ToolCallback toolCallback) {
            this.toolCallbacks.add(toolCallback);

            return this;
        }

        /**
         * Sets the static system message for the agent.
         *
         * @param systemMessage the static system message content
         * @return this builder instance for method chaining
         */
        public Builder systemMessage(final String systemMessage) {
            this.systemMessage = systemMessage;

            return this;
        }

        /**
         * Sets the dynamic system message provider for the agent.
         *
         * @param systemMessageProvider function that generates system messages dynamically
         * @return this builder instance for method chaining
         */
        public Builder systemMessageProvider(final Function<LocalAgent, String> systemMessageProvider) {
            this.systemMessageProvider = systemMessageProvider;

            return this;
        }

        /**
         * Sets the chat memory implementation for conversation persistence.
         *
         * @param chatMemory the Spring AI ChatMemory implementation
         * @return this builder instance for method chaining
         */
        public Builder chatMemory(final ChatMemory chatMemory) {
            this.chatMemory = chatMemory;

            return this;
        }

        /**
         * Sets the initial messages
         *
         * @param messages the initial Messages for the agent
         * @return this builder instance for method chaining
         */
        public Builder messages(final List<BaseMessage> messages) {
            this.messages = messages;

            return this;
        }

        /**
         * Builds and returns a new SpringAIAgent instance with the configured parameters.
         *
         * @return a new SpringAIAgent instance
         * @throws AGUIException if the configuration is invalid or required parameters are missing
         */
        public SpringAIAgent build() throws AGUIException {
            return new SpringAIAgent(this);
        }
    }

}