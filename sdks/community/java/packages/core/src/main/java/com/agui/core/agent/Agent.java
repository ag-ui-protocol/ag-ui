package com.agui.core.agent;

import com.agui.core.message.BaseMessage;

import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 *
 * Core interface for AI agent execution within the agui framework.
 * <p>
 * The Agent interface defines the fundamental contract for running AI agents
 * asynchronously. Implementations of this interface handle the orchestration
 * of agent execution, including message processing, tool calls, and state management.
 * <p>
 * Agent execution is designed to be non-blocking through the use of CompletableFuture,
 * allowing for efficient resource utilization and responsive user interfaces.
 * Progress and events during execution are communicated through the provided
 * AgentSubscriber callback interface.
 *
 * @author Pascal Wilbrink
 */
public interface Agent {

    /**
     * Executes the agent asynchronously with the specified parameters and subscriber.
     * <p>
     * This method initiates agent execution in a non-blocking manner, returning
     * immediately with a CompletableFuture that will complete when the agent
     * run finishes (either successfully or with an error).
     * <p>
     * During execution, the agent will invoke methods on the provided subscriber
     * to communicate progress, events, and state changes in real-time. This allows
     * for monitoring, logging, and user interface updates during long-running
     * agent operations.
     * <p>
     * The returned CompletableFuture will complete with:
     * <ul>
     * <li>Success (null value) when the agent completes its execution successfully</li>
     * <li>Exception when the agent encounters an unrecoverable error</li>
     * </ul>
     *
     * @param parameters the configuration and input parameters for this agent run,
     *                  including context, messages, tools, and execution settings
     * @param subscriber the callback interface for receiving real-time updates
     *                  about agent execution progress, events, and state changes
     * @return a CompletableFuture that completes when the agent run finishes,
     *         with null on success or an exception on failure
     * @throws IllegalArgumentException if parameters or subscriber are null
     * @throws IllegalStateException if the agent is not in a valid state for execution
     */
    CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber);

    List<BaseMessage> getMessages();

}