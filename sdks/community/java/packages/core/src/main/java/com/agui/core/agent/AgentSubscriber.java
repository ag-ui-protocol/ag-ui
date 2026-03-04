package com.agui.core.agent;

import com.agui.core.event.*;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.tool.ToolCall;

/**
 * Interface for subscribing to agent lifecycle events, state changes, and real-time updates.
 * <p>
 * AgentSubscriber provides a comprehensive set of callback methods that allow implementers to
 * monitor and react to various aspects of agent execution, including:
 * <ul>
 * <li>Request lifecycle management (initialization, completion, errors)</li>
 * <li>Real-time event streaming during agent execution</li>
 * <li>State and message updates</li>
 * </ul>
 * <p>
 * All methods have default empty implementations, allowing implementers to selectively
 * override only the events they're interested in.
 *
 * @author Pascal Wilbrink
 */
public interface AgentSubscriber {

    // Request lifecycle

    /**
     * Called when an agent run is initialized and about to begin execution.
     * <p>
     * This method is invoked at the start of the agent execution lifecycle,
     * providing access to the initial parameters and context.
     *
     * @param params the parameters and context for this agent run
     */
    default void onRunInitialized(AgentSubscriberParams params) { }

    /**
     * Called when an agent run fails due to an error or exception.
     * <p>
     * This method provides both the run parameters and the specific error
     * that caused the failure, allowing for error handling and recovery.
     *
     * @param params the parameters and context for this agent run
     * @param error the throwable that caused the run to fail
     */
    default void onRunFailed(AgentSubscriberParams params, Throwable error) { }

    /**
     * Called when an agent run is finalized, regardless of success or failure.
     * <p>
     * This method is always invoked at the end of the agent execution lifecycle,
     * making it suitable for cleanup operations and resource management.
     *
     * @param params the parameters and context for this agent run
     */
    default void onRunFinalized(AgentSubscriberParams params) { }

    // Events

    /**
     * Called for any event that occurs during agent execution.
     * <p>
     * This is a catch-all method that receives all events. It's useful for
     * logging, debugging, or when you need to handle all event types uniformly.
     *
     * @param event the base event that occurred
     */
    default void onEvent(BaseEvent event) { }

    /**
     * Called when an agent run begins execution.
     *
     * @param event the run started event containing execution details
     */
    default void onRunStartedEvent(RunStartedEvent event) { }

    /**
     * Called when an agent run completes execution successfully.
     *
     * @param event the run finished event containing completion details
     */
    default void onRunFinishedEvent(RunFinishedEvent event) { }

    /**
     * Called when an error occurs during agent run execution.
     *
     * @param event the run error event containing error details
     */
    default void onRunErrorEvent(RunErrorEvent event) { }

    /**
     * Called when an individual step within the agent execution begins.
     *
     * @param event the step started event containing step details
     */
    default void onStepStartedEvent(StepStartedEvent event) { }

    /**
     * Called when an individual step within the agent execution completes.
     *
     * @param event the step finished event containing completion details
     */
    default void onStepFinishedEvent(StepFinishedEvent event) { }

    /**
     * Called when the agent begins generating a text message.
     *
     * @param event the text message start event
     */
    default void onTextMessageStartEvent(TextMessageStartEvent event) { }

    /**
     * Called as the agent streams text message content in real-time.
     * <p>
     * This method may be called multiple times for a single message as
     * content is generated incrementally.
     *
     * @param event the text message content event containing partial content
     */
    default void onTextMessageContentEvent(TextMessageContentEvent event) { }

    /**
     * Called when the agent finishes generating a text message.
     *
     * @param event the text message end event containing the complete message
     */
    default void onTextMessageEndEvent(TextMessageEndEvent event) { }

    /**
     * Called when the agent begins executing a tool call.
     *
     * @param event the tool call start event containing tool details
     */
    default void onToolCallStartEvent(ToolCallStartEvent event) { }

    /**
     * Called as the agent streams tool call arguments in real-time.
     * <p>
     * This method may be called multiple times for a single tool call as
     * arguments are generated incrementally.
     *
     * @param event the tool call args event containing partial arguments
     */
    default void onToolCallArgsEvent(ToolCallArgsEvent event) { }

    /**
     * Called when the agent finishes generating arguments for a tool call.
     *
     * @param event the tool call end event containing complete arguments
     */
    default void onToolCallEndEvent(ToolCallEndEvent event) { }

    /**
     * Called when a tool call execution completes and returns a result.
     *
     * @param event the tool call result event containing the execution result
     */
    default void onToolCallResultEvent(ToolCallResultEvent event) { }

    /**
     * Called when a complete state snapshot is available.
     * <p>
     * State snapshots provide a complete view of the agent's current state
     * at a specific point in time.
     *
     * @param event the state snapshot event containing the full state
     */
    default void onStateSnapshotEvent(StateSnapshotEvent event) { }

    /**
     * Called when incremental state changes occur.
     * <p>
     * State deltas provide only the changes that occurred since the last
     * state update, enabling efficient state tracking.
     *
     * @param event the state delta event containing state changes
     */
    default void onStateDeltaEvent(StateDeltaEvent event) { }

    /**
     * Called when a complete messages snapshot is available.
     * <p>
     * Message snapshots provide a complete view of all messages in the
     * conversation at a specific point in time.
     *
     * @param event the messages snapshot event containing all messages
     */
    default void onMessagesSnapshotEvent(MessagesSnapshotEvent event) { }

    /**
     * Called for raw, unprocessed events from the underlying system.
     * <p>
     * Raw events provide access to the original event data before any
     * processing or transformation by the agui framework.
     *
     * @param event the raw event containing unprocessed data
     */
    default void onRawEvent(RawEvent event) { }

    /**
     * Called for custom events that don't fit into the standard event types.
     * <p>
     * Custom events allow for application-specific event handling and
     * extensibility beyond the core event types.
     *
     * @param event the custom event containing application-specific data
     */
    default void onCustomEvent(CustomEvent event) { }

    // State changes

    /**
     * Called when the agent's message history changes.
     * <p>
     * This method is invoked whenever new messages are added to the conversation
     * or existing messages are modified.
     *
     * @param params the parameters and context for this agent run
     */
    default void onMessagesChanged(AgentSubscriberParams params) { }

    /**
     * Called when the agent's internal state changes.
     * <p>
     * This method is invoked whenever the agent's state is updated, providing
     * a way to track state evolution over time.
     *
     * @param state the State for this agent run
     */
    default void onStateChanged(State state) { }

    /**
     * Called when a new message is added to the conversation.
     * <p>
     * This method provides direct access to the new message without requiring
     * access to the full agent parameters.
     *
     * @param message the new message that was added
     */
    default void onNewMessage(BaseMessage message) { }

    /**
     * Called when a new tool call is initiated by the agent.
     * <p>
     * This method provides direct access to the tool call without requiring
     * access to the full agent parameters.
     *
     * @param toolCall the new tool call that was initiated
     */
    default void onNewToolCall(ToolCall toolCall) { }

}