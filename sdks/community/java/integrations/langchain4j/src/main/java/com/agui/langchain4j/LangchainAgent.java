package com.agui.langchain4j;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.state.State;
import com.agui.server.EventFactory;
import com.agui.server.LocalAgent;
import dev.langchain4j.agent.tool.ToolExecutionRequest;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.data.message.ToolExecutionResultMessage;
import dev.langchain4j.memory.ChatMemory;
import dev.langchain4j.model.chat.ChatModel;
import dev.langchain4j.model.chat.StreamingChatModel;
import dev.langchain4j.service.AiServices;
import dev.langchain4j.service.TokenStream;
import dev.langchain4j.service.UserMessage;
import dev.langchain4j.service.tool.ToolExecution;
import dev.langchain4j.service.tool.ToolExecutor;
import dev.langchain4j.service.tool.ToolProvider;
import com.agui.core.exception.AGUIException;

import java.util.*;
import java.util.function.Function;

import static com.agui.server.EventFactory.*;

/**
 * A concrete implementation of {@link LocalAgent} that integrates with the LangChain4j framework
 * to provide AI-powered agent capabilities.
 *
 * This agent leverages LangChain4j's AiServices to create a conversational assistant that can
 * handle streaming responses, tool execution, and memory management. It supports both regular
 * and streaming chat models, making it suitable for various AI interaction patterns.
 *
 * Key features:
 * <ul>
 * <li>Integration with LangChain4j AiServices and chat models</li>
 * <li>Support for both streaming and non-streaming chat models</li>
 * <li>Tool execution with custom tool providers and individual tools</li>
 * <li>Chat memory management for conversation persistence</li>
 * <li>Streaming response handling with real-time token updates</li>
 * <li>Custom handling of hallucinated tool names</li>
 * <li>Deferred tool call event processing</li>
 * </ul>
 *
 * @author Pascal Wilbrink
 * @since 1.0
 */
public class LangchainAgent extends LocalAgent {

    /**
     * The LangChain4j streaming chat model for real-time token streaming.
     */
    private StreamingChatModel streamingChatModel;

    /**
     * The LangChain4j chat model for non-streaming interactions.
     */
    private ChatModel chatModel;

    /**
     * Chat memory implementation for maintaining conversation history.
     */
    private ChatMemory chatMemory;

    /**
     * List of tool objects that the agent can use during conversations.
     */
    private List<Object> tools;

    /**
     * Tool provider for dynamic tool discovery and management.
     */
    private ToolProvider toolProvider;

    /**
     * Strategy function for handling cases where the model hallucinates tool names
     * that don't exist in the available tool set.
     */
    private Function<ToolExecutionRequest, ToolExecutionResultMessage> hallucinatedToolNameStrategy;

    private ToolMapper toolMapper;

    /**
     * Private constructor that initializes the LangchainAgent using the builder pattern.
     *
     * @param builder the Builder instance containing all configuration parameters
     * @throws AGUIException if the parent LocalAgent constructor validation fails
     */
    private LangchainAgent(final Builder builder) throws AGUIException {
        super(
            builder.agentId,
            builder.state,
            builder.systemMessageProvider,
            builder.systemMessage,
            new ArrayList<>()
        );

        this.streamingChatModel = builder.streamingChatModel;
        this.chatModel = builder.chatModel;

        this.chatMemory = builder.chatMemory;

        this.tools = builder.tools;
        this.toolProvider = builder.toolProvider;

        this.hallucinatedToolNameStrategy = builder.hallucinatedToolNameStrategy;

        this.toolMapper = new ToolMapper();
    }

    /**
     * {@inheritDoc}
     *
     * Executes the agent by processing the latest user message through LangChain4j's AiServices.
     * The method handles the complete conversation lifecycle including:
     * <ul>
     * <li>Extracting the user message from input</li>
     * <li>Building the LangChain4j Assistant with configured tools and memory</li>
     * <li>Streaming the response with real-time token updates</li>
     * <li>Processing tool executions and emitting appropriate events</li>
     * <li>Managing conversation state and memory</li>
     * </ul>
     *
     * Events are emitted throughout the process to provide real-time updates to subscribers.
     * Tool executions are deferred and processed after the main response is complete.
     */
    @Override
    protected void run(RunAgentInput input, AgentSubscriber subscriber) {
        var messageId = UUID.randomUUID().toString();

        var threadId = input.threadId();

        var runId = input.runId();

        String content;

        try {
            var lastUserMessage = this.getLatestUserMessage(input.messages());
            content = lastUserMessage.getContent();
        } catch (AGUIException e) {
            this.emitEvent(runErrorEvent(e.getMessage()), subscriber);
            return;
        }

        var deferredToolCalls = new ArrayList<ToolExecution>();

        var assistant = this.buildAssistant(input);

        this.emitEvent(runStartedEvent(threadId, runId), subscriber);
        this.emitEvent(textMessageStartEvent(messageId, "assistant"), subscriber);

        assistant.chat(content)
                .onToolExecuted(deferredToolCalls::add)
                .onCompleteResponse((res) -> {
                    this.emitEvent(textMessageEndEvent(messageId), subscriber);

                    deferredToolCalls.forEach(toolCall -> {
                        var toolCallId = UUID.randomUUID().toString();
                        this.emitEvent(EventFactory.toolCallStartEvent(messageId, toolCall.request().name(), toolCallId), subscriber);
                        this.emitEvent(EventFactory.toolCallArgsEvent(toolCall.request().arguments(), toolCallId), subscriber);
                        this.emitEvent(EventFactory.toolCallEndEvent(toolCallId), subscriber);
                    });

                    this.emitEvent(runFinishedEvent(threadId, runId), subscriber);

                    subscriber.onRunFinalized(new AgentSubscriberParams(input.messages(), state, this, input));
                })
                .onError((err) -> this.emitEvent(runErrorEvent(err.getMessage()), subscriber))
                .onPartialResponse((res) -> this.emitEvent(textMessageContentEvent(messageId, res), subscriber))
                .start();
    }

    /**
     * Builds a LangChain4j Assistant instance configured with all the agent's settings.
     *
     * This method creates an AiServices builder and configures it with:
     * <ul>
     * <li>Chat model (streaming or non-streaming)</li>
     * <li>Chat memory for conversation persistence</li>
     * <li>Available tools and tool providers</li>
     * <li>Hallucinated tool name strategy</li>
     * <li>System message provider that includes current context and state</li>
     * </ul>
     *
     * @return a configured Assistant instance ready for conversation
     */
    private Assistant buildAssistant(final RunAgentInput input) {
        AiServices<Assistant> builder = AiServices.builder(Assistant.class);

        if (Objects.nonNull(this.streamingChatModel)) {
            builder = builder.streamingChatModel(this.streamingChatModel);
        }

        if (Objects.nonNull(this.chatModel)) {
            builder = builder.chatModel(this.chatModel);
        }

        if (Objects.nonNull(this.chatMemory)) {
            builder = builder.chatMemory(chatMemory);
        }

        if (Objects.nonNull(this.tools) && !this.tools.isEmpty()) {
            builder = builder.tools(this.tools);
        }

        if (Objects.nonNull(tools) && !tools.isEmpty()) {
            ToolExecutor toolExecutor = (toolExecutionRequest, memoryId) -> "Tool executed";

            Map<ToolSpecification, ToolExecutor> toolSpecifications = new HashMap<>();

            input.tools()
                .stream()
                .map(this.toolMapper::toLangchainTool)
                .forEach(toolSpecification -> toolSpecifications.put(toolSpecification, toolExecutor));

            builder = builder.tools(toolSpecifications);
        }

        if (Objects.nonNull(this.toolProvider)) {
            builder = builder.toolProvider(this.toolProvider);
        }

        if (Objects.nonNull(this.hallucinatedToolNameStrategy)) {
            builder = builder.hallucinatedToolNameStrategy(this.hallucinatedToolNameStrategy);
        }

        builder = builder.systemMessageProvider(memoryId -> this.createSystemMessage(state, input.context()).getContent());

        return builder.build();
    }

    /**
     * Creates a new Builder instance for constructing LangchainAgent instances.
     *
     * @return a new Builder instance
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Builder class for constructing LangchainAgent instances using the builder pattern.
     *
     * This builder provides a fluent API for configuring all aspects of the LangchainAgent
     * including chat models, tools, memory, and agent-specific settings. It supports both
     * streaming and non-streaming chat models, allowing for flexible configuration based
     * on the specific use case requirements.
     */
    public static class Builder {

        /**
         * Unique identifier for the agent being built.
         */
        private String agentId;

        /**
         * Static system message content for the agent.
         */
        private String systemMessage;

        /**
         * Dynamic system message provider function.
         */
        private Function<LocalAgent, String> systemMessageProvider;

        /**
         * Initial state for the agent being built.
         */
        private State state;

        /**
         * LangChain4j streaming chat model for real-time interactions.
         */
        private StreamingChatModel streamingChatModel;

        /**
         * LangChain4j chat model for standard interactions.
         */
        private ChatModel chatModel;

        /**
         * Strategy for handling hallucinated tool names.
         */
        private Function<ToolExecutionRequest, ToolExecutionResultMessage> hallucinatedToolNameStrategy;

        /**
         * Chat memory implementation for conversation persistence.
         */
        private ChatMemory chatMemory;

        /**
         * Tool provider for dynamic tool management.
         */
        private ToolProvider toolProvider;

        /**
         * List of available tools for the agent.
         */
        private final List<Object> tools = new ArrayList<>();

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
         * Sets the LangChain4j ChatModel for standard (non-streaming) interactions.
         *
         * @param chatModel the LangChain4j ChatModel to use
         * @return this builder instance for method chaining
         */
        public Builder chatModel(final ChatModel chatModel) {
            this.chatModel = chatModel;

            return this;
        }

        /**
         * Sets the LangChain4j StreamingChatModel for real-time streaming interactions.
         *
         * @param streamingChatModel the LangChain4j StreamingChatModel to use
         * @return this builder instance for method chaining
         */
        public Builder streamingChatModel(final StreamingChatModel streamingChatModel) {
            this.streamingChatModel = streamingChatModel;

            return this;
        }

        /**
         * Sets the strategy for handling hallucinated tool names.
         *
         * This strategy is invoked when the model attempts to call a tool that doesn't
         * exist in the available tool set, allowing for custom error handling or
         * fallback behavior.
         *
         * @param hallucinatedToolNameStrategy function to handle hallucinated tool execution requests
         * @return this builder instance for method chaining
         */
        public Builder hallucinatedToolNameStrategy(Function<ToolExecutionRequest, ToolExecutionResultMessage> hallucinatedToolNameStrategy) {
            this.hallucinatedToolNameStrategy = hallucinatedToolNameStrategy;

            return this;
        }

        /**
         * Sets the chat memory implementation for conversation persistence.
         *
         * @param chatMemory the LangChain4j ChatMemory implementation
         * @return this builder instance for method chaining
         */
        public Builder chatMemory(final ChatMemory chatMemory) {
            this.chatMemory = chatMemory;

            return this;
        }

        /**
         * Adds multiple tools to the agent configuration.
         *
         * @param tools list of tool objects to add
         * @return this builder instance for method chaining
         */
        public Builder tools(final List<Object> tools) {
            this.tools.addAll(tools);

            return this;
        }

        /**
         * Adds a single tool to the agent configuration.
         *
         * @param tool the tool object to add
         * @return this builder instance for method chaining
         */
        public Builder tool(final Object tool) {
            this.tools.add(tool);

            return this;
        }

        /**
         * Sets the tool provider for dynamic tool discovery and management.
         *
         * @param toolProvider the LangChain4j ToolProvider implementation
         * @return this builder instance for method chaining
         */
        public Builder toolProvider(final ToolProvider toolProvider) {
            this.toolProvider = toolProvider;

            return this;
        }

        /**
         * Builds and returns a new LangchainAgent instance with the configured parameters.
         *
         * @return a new LangchainAgent instance
         * @throws AGUIException if the configuration is invalid or required parameters are missing
         */
        public LangchainAgent build() throws AGUIException {
            return new LangchainAgent(this);
        }
    }

    /**
     * Internal interface that defines the contract for the LangChain4j Assistant.
     *
     * This interface is used by LangChain4j's AiServices to create a proxy that handles
     * the conversation flow, tool execution, and response streaming. The interface
     * abstracts the complexity of the underlying AI service interactions.
     */
    interface Assistant {

        /**
         * Initiates a chat conversation with the given user message.
         *
         * This method returns a TokenStream that allows for real-time processing
         * of the AI response, including partial responses, tool executions, and
         * completion callbacks.
         *
         * @param message the user message to send to the AI model
         * @return a TokenStream for handling the streaming response
         */
        TokenStream chat(@UserMessage final String message);

    }
}