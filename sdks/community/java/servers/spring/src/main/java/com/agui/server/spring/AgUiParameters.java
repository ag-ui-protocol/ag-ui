package com.agui.server.spring;

import com.agui.core.context.Context;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;

import java.util.List;

/**
 * Parameter object for Spring-based agent execution requests.
 * <p>
 * AgUiParameters encapsulates all the necessary configuration and context information
 * needed to execute an agent within a Spring web environment. This class serves as
 * a data transfer object (DTO) for HTTP requests that initiate agent execution,
 * providing a clean separation between web layer concerns and core agent functionality.
 * <p>
 * The class includes all standard agent execution parameters such as conversation
 * context, available tools, state information, and execution settings. It's designed
 * to be easily serialized from JSON request bodies in Spring controllers.
 * <p>
 * Key components:
 * <ul>
 * <li><strong>Threading:</strong> Thread and run identifiers for conversation management</li>
 * <li><strong>Tools:</strong> Available functions and tools for agent execution</li>
 * <li><strong>Context:</strong> Additional execution context and metadata</li>
 * <li><strong>State:</strong> Agent state and conversation history</li>
 * <li><strong>Messages:</strong> Current conversation messages and history</li>
 * <li><strong>Properties:</strong> Forwarded properties for custom configuration</li>
 * </ul>
 * <p>
 * This class follows standard JavaBean conventions with getter and setter methods
 * for all properties, making it compatible with Spring's automatic JSON deserialization
 * and form binding mechanisms.
 * <p>
 * Example usage in a Spring controller:
 * <pre>{@code
 * @PostMapping("/run-agent")
 * public SseEmitter runAgent(@RequestBody AgUiParameters params) {
 *     return agUiService.runAgent(myAgent, params);
 * }
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class AgUiParameters {

    private String threadId;
    private String runId;
    private List<Tool> tools;
    private List<Context> context;
    private Object forwardedProps;
    private List<BaseMessage> messages;
    private State state;

    /**
     * Sets the conversation thread identifier.
     *
     * @param threadId the unique identifier for the conversation thread
     */
    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    /**
     * Gets the conversation thread identifier.
     *
     * @return the thread identifier, or null if not set
     */
    public String getThreadId() {
        return this.threadId;
    }

    /**
     * Sets the unique run identifier for this execution.
     *
     * @param runId the unique identifier for this agent run
     */
    public void setRunId(final String runId) {
        this.runId = runId;
    }

    /**
     * Gets the unique run identifier for this execution.
     *
     * @return the run identifier, or null if not set
     */
    public String getRunId() {
        return runId;
    }

    /**
     * Sets the list of tools available to the agent during execution.
     *
     * @param tools the list of available tools, or null if no tools are available
     */
    public void setTools(final List<Tool> tools) {
        this.tools = tools;
    }

    /**
     * Gets the list of tools available to the agent during execution.
     *
     * @return the list of available tools, or null if not set
     */
    public List<Tool> getTools() {
        return tools;
    }

    /**
     * Sets the list of context objects providing additional execution information.
     *
     * @param context the list of context objects, or null if no additional context is needed
     */
    public void setContext(final List<Context> context) {
        this.context = context;
    }

    /**
     * Gets the list of context objects providing additional execution information.
     *
     * @return the list of context objects, or null if not set
     */
    public List<Context> getContext() {
        return this.context;
    }

    /**
     * Sets the forwarded properties object containing arbitrary additional configuration.
     *
     * @param forwardedProps the forwarded properties object, or null if not needed
     */
    public void setForwardedProps(final Object forwardedProps) {
        this.forwardedProps = forwardedProps;
    }

    /**
     * Gets the forwarded properties object containing arbitrary additional configuration.
     *
     * @return the forwarded properties object, or null if not set
     */
    public Object getForwardedProps() {
        return this.forwardedProps;
    }

    /**
     * Sets the conversation message history.
     *
     * @param messages the list of conversation messages, or null for empty history
     */
    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;
    }

    /**
     * Gets the conversation message history.
     *
     * @return the list of conversation messages, or null if not set
     */
    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    /**
     * Sets the agent state containing persistent context and configuration.
     *
     * @param state the agent state object, or null for default empty state
     */
    public void setState(State state) {
        this.state = state;
    }

    /**
     * Gets the agent state containing persistent context and configuration.
     *
     * @return the agent state object, or null if not set
     */
    public State getState() {
        return state;
    }
}


