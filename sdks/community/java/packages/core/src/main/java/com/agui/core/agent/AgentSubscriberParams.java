package com.agui.core.agent;

import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;

import java.util.List;

/**
 * Immutable parameter object containing context and state information for agent subscriber callbacks.
 * <p>
 * This record encapsulates all the essential information that subscriber methods need to
 * understand the current state of an agent execution. It provides access to the conversation
 * history, current agent state, the executing agent instance, and the original input parameters.
 * <p>
 * Being a record, AgentSubscriberParams is immutable and automatically provides equals(),
 * hashCode(), and toString() implementations based on its components.
 *
 * @param messages the current list of messages in the conversation history,
 *                including both user and agent messages up to this point
 * @param state    the current internal state of the agent, containing execution
 *                context and any intermediate data
 * @param agent    the agent instance that is currently executing and generating
 *                these subscriber callbacks
 * @param input    the original input parameters that were provided when the
 *                agent run was initiated
 *
 * @author Pascal Wilbrink
 */
public record AgentSubscriberParams(List<BaseMessage> messages, State state, Agent agent, RunAgentInput input) { }