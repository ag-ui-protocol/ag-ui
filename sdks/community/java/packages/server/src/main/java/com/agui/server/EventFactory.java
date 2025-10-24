package com.agui.server;

import com.agui.core.event.*;
import com.agui.core.message.Role;
import com.agui.core.state.State;

/**
 * Utility factory class for creating commonly used event instances with proper configuration.
 * <p>
 * EventFactory provides static factory methods for creating various types of events used
 * throughout the ag-ui framework. This centralized approach ensures consistent event
 * creation with proper parameter mapping and reduces boilerplate code when constructing
 * events in agent implementations.
 * <p>
 * The factory methods handle the creation and initialization of event objects, setting
 * appropriate properties and ensuring that events are properly configured for emission
 * to subscribers. This includes setting timestamps, IDs, and other metadata automatically.
 * <p>
 * Supported event types:
 * <ul>
 * <li>Run lifecycle events (start, finish, error)</li>
 * <li>Text message events (start, content, end)</li>
 * <li>Tool call events (start, args, end)</li>
 * </ul>
 * <p>
 * This class is designed as a utility class with static methods and cannot be instantiated.
 * All methods are thread-safe and can be called concurrently from multiple threads.
 * <p>
 * Example usage:
 * <pre>{@code
 * // Create a run started event
 * RunStartedEvent startEvent = EventFactory.runStartedEvent("thread-123", "run-456");
 *
 * // Create a text message content event
 * TextMessageContentEvent contentEvent = EventFactory.textMessageContentEvent("msg-789", "Hello");
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class EventFactory {

    /**
     * Private constructor to prevent instantiation of this utility class.
     * <p>
     * This class is designed to be used only through its static methods
     * and should not be instantiated.
     */
    private EventFactory() {
        // private Constructor to remove instantiation
    }

    /**
     * Creates a new RunStartedEvent with the specified thread and run identifiers.
     * <p>
     * This event signals the beginning of an agent execution run within a specific
     * conversation thread. It should be emitted at the start of agent processing
     * to notify subscribers that execution has begun.
     *
     * @param threadId the conversation thread identifier
     * @param runId    the unique run identifier for this execution
     * @return a configured RunStartedEvent ready for emission
     */
    public static RunStartedEvent runStartedEvent(final String threadId, final String runId) {
        var event = new RunStartedEvent();
        event.setThreadId(threadId);
        event.setRunId(runId);

        return event;
    }

    /**
     * Creates a new TextMessageStartEvent with the specified message ID and role.
     * <p>
     * This event signals the beginning of a streaming text message. It should be
     * emitted before any content chunks to notify subscribers that a new message
     * stream is starting.
     *
     * @param messageId the unique identifier for the message being started
     * @param role      the role of the message sender (e.g., "assistant", "user")
     * @return a configured TextMessageStartEvent ready for emission
     */
    public static TextMessageStartEvent textMessageStartEvent(final String messageId, final String role) {
        var event = new TextMessageStartEvent();
        event.setMessageId(messageId);
        event.setRole(role);

        return event;
    }

    /**
     * Creates a new TextMessageContentEvent with the specified message ID and content delta.
     * <p>
     * This event represents incremental content being added to a streaming message.
     * It should be emitted for each content chunk as it becomes available during
     * message generation.
     *
     * @param messageId the unique identifier for the message receiving content
     * @param delta     the incremental content to add to the message
     * @return a configured TextMessageContentEvent ready for emission
     */
    public static TextMessageContentEvent textMessageContentEvent(final String messageId, final String delta) {
        var event = new TextMessageContentEvent();
        event.setMessageId(messageId);
        event.setDelta(delta);

        return event;
    }

    /**
     * Creates a new TextMessageEndEvent with the specified message ID.
     * <p>
     * This event signals the completion of a streaming text message. It should be
     * emitted after all content chunks have been sent to notify subscribers that
     * the message is complete.
     *
     * @param messageId the unique identifier for the message being completed
     * @return a configured TextMessageEndEvent ready for emission
     */
    public static TextMessageEndEvent textMessageEndEvent(final String messageId) {
        var event = new TextMessageEndEvent();
        event.setMessageId(messageId);

        return event;
    }

    /**
     * Creates a new RunFinishedEvent with the specified thread and run identifiers.
     * <p>
     * This event signals the successful completion of an agent execution run.
     * It should be emitted when the agent has finished processing and all
     * associated events have been sent.
     *
     * @param threadId the conversation thread identifier
     * @param runId    the unique run identifier for this execution
     * @return a configured RunFinishedEvent ready for emission
     */
    public static RunFinishedEvent runFinishedEvent(String threadId, String runId) {
        var event = new RunFinishedEvent();
        event.setThreadId(threadId);
        event.setRunId(runId);

        return event;
    }

    /**
     * Creates a new ToolCallStartEvent with the specified parameters.
     * <p>
     * This event signals the beginning of a tool/function call execution.
     * It should be emitted when the agent initiates a tool call as part of
     * its response generation.
     *
     * @param messageId  the unique identifier of the parent message
     * @param name       the name of the tool/function being called
     * @param toolCallId the unique identifier for this specific tool call
     * @return a configured ToolCallStartEvent ready for emission
     */
    public static ToolCallStartEvent toolCallStartEvent(String messageId, String name, String toolCallId) {
        var event = new ToolCallStartEvent();
        event.setParentMessageId(messageId);
        event.setToolCallName(name);
        event.setToolCallId(toolCallId);

        return event;
    }

    /**
     * Creates a new ToolCallArgsEvent with the specified arguments and tool call ID.
     * <p>
     * This event represents the arguments being passed to a tool/function call.
     * It should be emitted after the tool call start event to provide the
     * arguments that will be used for the tool execution.
     *
     * @param arguments  the arguments being passed to the tool (typically JSON)
     * @param toolCallId the unique identifier for the tool call receiving these arguments
     * @return a configured ToolCallArgsEvent ready for emission
     */
    public static ToolCallArgsEvent toolCallArgsEvent(String arguments, String toolCallId) {
        var event = new ToolCallArgsEvent();
        event.setDelta(arguments);
        event.setToolCallId(toolCallId);

        return event;
    }

    /**
     * Creates a new ToolCallEndEvent with the specified tool call ID.
     * <p>
     * This event signals the completion of a tool/function call execution.
     * It should be emitted when the tool call has finished processing,
     * regardless of success or failure.
     *
     * @param toolCallId the unique identifier for the tool call being completed
     * @return a configured ToolCallEndEvent ready for emission
     */
    public static ToolCallEndEvent toolCallEndEvent(String toolCallId) {
        var event = new ToolCallEndEvent();
        event.setToolCallId(toolCallId);

        return event;
    }

    /**
     * Creates a new RunErrorEvent with the specified error message.
     * <p>
     * This event signals that an error has occurred during agent execution.
     * It should be emitted when the agent encounters an unrecoverable error
     * that prevents normal completion of the run.
     *
     * @param message the error message describing what went wrong
     * @return a configured RunErrorEvent ready for emission
     */
    public static RunErrorEvent runErrorEvent(String message) {
        var event = new RunErrorEvent();
        event.setError(message);

        return event;
    }

    public static ToolCallResultEvent toolCallResultEvent(String toolCallId, String content, String messageId, Role role) {
        var event = new ToolCallResultEvent();
        event.setToolCallId(toolCallId);
        event.setMessageId(messageId);
        event.setRole(role);
        event.setContent(content);

        return event;
    }

    public static StateSnapshotEvent stateSnapshotEvent(final State state) {
        var event = new StateSnapshotEvent();
        event.setState(state);

        return event;
    }
}
