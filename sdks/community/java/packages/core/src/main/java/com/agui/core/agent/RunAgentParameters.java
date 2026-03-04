package com.agui.core.agent;

import com.agui.core.context.Context;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * Immutable configuration parameters for agent execution using the Builder pattern.
 * <p>
 * RunAgentParameters provides a flexible way to configure agent execution through a fluent
 * builder interface. This class encapsulates the core configuration needed to run an agent,
 * including available tools, execution context, and optional properties.
 * <p>
 * The class follows the Builder pattern to provide a clean, readable API for constructing
 * parameter objects with optional components. Convenience factory methods are provided for
 * common use cases.
 * <p>
 * Example usage:
 * <pre>{@code
 * RunAgentParameters params = RunAgentParameters.builder()
 *     .runId("run-123")
 *     .tools(availableTools)
 *     .context(executionContext)
 *     .build();
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class RunAgentParameters {
    private final String threadId;
    private final String runId;
    private final List<BaseMessage> messages;
    private final List<Tool> tools;
    private final List<Context> context;
    private final Object forwardedProps;
    private final State state;

    /**
     * Private constructor that accepts a builder to ensure immutability.
     *
     * @param builder the builder containing the configuration values
     */
    private RunAgentParameters(Builder builder) {
        this.threadId = builder.threadId;
        this.runId = builder.runId;
        this.messages = builder.messages;
        this.tools = Objects.isNull(builder.tools) ? new ArrayList<>() : builder.tools;
        this.context = Objects.isNull(builder.context) ? new ArrayList<>() : builder.context;
        this.forwardedProps = builder.forwardedProps;
        this.state = builder.state;
    }

    /**
     * Gets the unique identifier for this thread.
     *
     * @return the thread ID, or null if not specified
     */
    public String getThreadId() {
        return this.threadId;
    }
    /**
     * Gets the unique identifier for this agent run.
     *
     * @return the run ID, or null if not specified
     */
    public String getRunId() {
        return runId;
    }

    /**
     * Gets the list of messages available to the agent during execution.
     *
     * @return the list of messages
     */
    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    /**
     * Gets the list of tools available to the agent during execution.
     *
     * @return the list of available tools, or null if not specified
     */
    public List<Tool> getTools() {
        return tools;
    }

    /**
     * Gets the list of context objects that provide additional execution information.
     *
     * @return the list of context objects, or null if not specified
     */
    public List<Context> getContext() {
        return context;
    }

    /**
     * Gets the state.
     *
     * @return the state
     */
    public State getState() {
        return state;
    }

    /**
     * Gets the forwarded properties object containing arbitrary additional configuration.
     *
     * @return the forwarded properties object, or null if not specified
     */
    public Object getForwardedProps() {
        return forwardedProps;
    }

    /**
     * Builder class for constructing RunAgentParameters instances using a fluent interface.
     * <p>
     * The Builder allows for optional configuration of agent parameters, with all fields
     * being optional and defaulting to null if not specified.
     */
    public static class Builder {
        private String threadId;
        private String runId;
        private List<BaseMessage> messages;
        private List<Tool> tools;
        private List<Context> context;
        private State state;
        private Object forwardedProps;

        /**
         * Sets the unique identifier for this thread.
         *
         * @param threadId the unique thread identifier
         * @return this builder instance for method chaining
         */
        public Builder threadId(String threadId) {
            this.threadId = threadId;
            return this;
        }

        /**
         * Sets the unique identifier for this agent run.
         *
         * @param runId the unique run identifier
         * @return this builder instance for method chaining
         */
        public Builder runId(String runId) {
            this.runId = runId;
            return this;
        }

        /**
         * Sets the messages for this agent run
         *
         * @param messages the list of messages
         * @return this builder instance for method chaining
         */
        public Builder messages(final List<BaseMessage> messages) {
            this.messages = messages;
            return this;
        }

        /**
         * Sets the list of tools available to the agent during execution.
         *
         * @param tools the list of available tools
         * @return this builder instance for method chaining
         */
        public Builder tools(List<Tool> tools) {
            this.tools = tools;
            return this;
        }

        /**
         * Sets the list of context objects that provide additional execution information.
         *
         * @param context the list of context objects
         * @return this builder instance for method chaining
         */
        public Builder context(List<Context> context) {
            this.context = context;
            return this;
        }

        /**
         * Sets the state of the agent
         *
         * @param state the State of the agent
         * @return this builder instance for method chaining
         */
        public Builder state(State state) {
            this.state = state;
            return this;
        }

        /**
         * Sets the forwarded properties object containing arbitrary additional configuration.
         *
         * @param forwardedProps the forwarded properties object
         * @return this builder instance for method chaining
         */
        public Builder forwardedProps(Object forwardedProps) {
            this.forwardedProps = forwardedProps;
            return this;
        }

        /**
         * Constructs a new RunAgentParameters instance with the current builder configuration.
         *
         * @return a new immutable RunAgentParameters instance
         */
        public RunAgentParameters build() {
            return new RunAgentParameters(this);
        }
    }

    /**
     * Creates a new builder instance for constructing RunAgentParameters.
     *
     * @return a new Builder instance
     */
    public static Builder builder() {
        return new Builder();
    }

    /**
     * Creates an empty RunAgentParameters instance with all fields set to null.
     * <p>
     * This is a convenience method equivalent to {@code builder().build()}.
     *
     * @return a new empty RunAgentParameters instance
     */
    public static RunAgentParameters empty() {
        return new Builder().build();
    }

    /**
     * Creates a RunAgentParameters instance with only the run ID specified.
     * <p>
     * This is a convenience method for the common case where only a run ID is needed.
     *
     * @param runId the unique run identifier
     * @return a new RunAgentParameters instance with the specified run ID
     */
    public static RunAgentParameters withRunId(String runId) {
        return new Builder().runId(runId).build();
    }
}