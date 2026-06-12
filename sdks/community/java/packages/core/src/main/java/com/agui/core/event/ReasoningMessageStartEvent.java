package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the beginning of a reasoning message stream.
 * <p>
 * Reasoning messages convey assistant chain-of-thought / reasoning traces
 * that are surfaced to the UI separately from the primary text message
 * stream. They are emitted by integrations that expose reasoning content
 * (e.g. OpenAI o1-style reasoning, Anthropic extended thinking) and are
 * consumed by client renderers that display the reasoning inline with
 * the assistant turn.
 * </p>
 * <p>
 * The event automatically sets its type to
 * {@link EventType#REASONING_MESSAGE_START} and establishes the context
 * for the reasoning content events that follow. The {@code role} field
 * mirrors the AG-UI protocol wire schema where reasoning messages carry
 * the literal role {@code "reasoning"}.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#REASONING_MESSAGE_START
 * @see ReasoningMessageContentEvent
 * @see ReasoningMessageEndEvent
 */
public class ReasoningMessageStartEvent extends BaseEvent {

    private String messageId;
    private String role;

    /**
     * Creates a new ReasoningMessageStartEvent with type set to
     * {@link EventType#REASONING_MESSAGE_START}.
     * <p>
     * The timestamp is automatically set to the current time and both
     * fields are initialized as null. Per the AG-UI protocol the
     * {@code role} should be set to {@code "reasoning"}.
     * </p>
     */
    public ReasoningMessageStartEvent() {
        super(EventType.REASONING_MESSAGE_START);
    }

    /**
     * Sets the unique identifier for the reasoning message that is
     * starting to stream.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier for the reasoning message that is
     * starting to stream.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }

    /**
     * Sets the role of the reasoning message. Per the AG-UI protocol
     * this is the literal {@code "reasoning"}.
     *
     * @param role the role string. Can be null.
     */
    public void setRole(final String role) {
        this.role = role;
    }

    /**
     * Returns the role of the reasoning message.
     *
     * @return the role string, can be null
     */
    public String getRole() {
        return this.role;
    }
}
