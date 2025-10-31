package com.agui.core.agent;

import com.agui.core.context.Context;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;

import java.util.List;

/**
 * Immutable input parameters for agent execution containing all necessary context and configuration.
 * <p>
 * This record encapsulates all the information required to initiate and configure an agent run,
 * including conversation history, available tools, execution context, and identification metadata.
 * The input serves as a complete specification for how the agent should execute and what resources
 * it has access to.
 * <p>
 * Being a record, RunAgentInput is immutable and automatically provides equals(), hashCode(),
 * and toString() implementations based on its components.
 *
 * @param threadId       unique identifier for the conversation thread this run belongs to,
 *                      used for tracking and associating related agent executions
 * @param runId          unique identifier for this specific agent run instance,
 *                      allowing for precise identification and tracking of individual executions
 * @param state          the initial state for the agent execution, containing any persistent
 *                      data or configuration that should be maintained across interactions
 * @param messages       the conversation history leading up to this execution, including
 *                      all user and agent messages that provide context for the current run
 * @param tools          the list of available tools that the agent can invoke during execution,
 *                      defining the agent's capabilities and available actions
 * @param context        additional context objects that provide environmental information,
 *                      constraints, or configuration for the agent execution
 * @param forwardedProps arbitrary properties forwarded from the calling context, allowing
 *                      for flexible extension and custom configuration without modifying
 *                      the core input structure
 *
 * @author Pascal Wilbrink
 */
public record RunAgentInput(
    String threadId,
    String runId,
    State state,
    List<BaseMessage> messages,
    List<Tool> tools,
    List<Context> context,
    Object forwardedProps
) { }