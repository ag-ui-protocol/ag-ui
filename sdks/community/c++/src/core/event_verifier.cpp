#include "event_verifier.h"

#include "core/error.h"

namespace agui {

EventVerifier::EventVerifier()
    : m_thinkingState(EventState::NotStarted),
      m_thinkingTextMessageState(EventState::NotStarted) {}

EventVerifier::~EventVerifier() = default;

void EventVerifier::verify(const Event& event) {
    EventType eventType = event.type();

    switch (eventType) {
        // Text message events — use dynamic_cast so that a type mismatch (e.g. a middleware
        // returned the wrong concrete type) throws a clear error instead of UB.
        case EventType::TextMessageStart: {
            const auto* e = dynamic_cast<const TextMessageStartEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::TextMessageStart but dynamic type mismatch");
            verifyTextMessage(eventType, e->messageId);
            break;
        }
        case EventType::TextMessageContent: {
            const auto* e = dynamic_cast<const TextMessageContentEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::TextMessageContent but dynamic type mismatch");
            verifyTextMessage(eventType, e->messageId);
            break;
        }
        case EventType::TextMessageEnd: {
            const auto* e = dynamic_cast<const TextMessageEndEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::TextMessageEnd but dynamic type mismatch");
            verifyTextMessage(eventType, e->messageId);
            break;
        }

        // Thinking text message events
        case EventType::ThinkingTextMessageStart:
        case EventType::ThinkingTextMessageContent:
        case EventType::ThinkingTextMessageEnd:
            verifyThinkingTextMessage(eventType);
            break;

        // Tool call events — same dynamic_cast pattern as text message events above.
        case EventType::ToolCallStart: {
            const auto* e = dynamic_cast<const ToolCallStartEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::ToolCallStart but dynamic type mismatch");
            verifyToolCall(eventType, e->toolCallId);
            break;
        }
        case EventType::ToolCallArgs: {
            const auto* e = dynamic_cast<const ToolCallArgsEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::ToolCallArgs but dynamic type mismatch");
            verifyToolCall(eventType, e->toolCallId);
            break;
        }
        case EventType::ToolCallEnd: {
            const auto* e = dynamic_cast<const ToolCallEndEvent*>(&event);
            if (!e) throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                                     "EventVerifier: EventType::ToolCallEnd but dynamic type mismatch");
            verifyToolCall(eventType, e->toolCallId);
            break;
        }

        // Thinking events
        case EventType::ThinkingStart:
        case EventType::ThinkingEnd:
            verifyThinking(eventType);
            break;

        // Other events don't require sequence validation
        default:
            break;
    }
}

void EventVerifier::verifyTextMessage(EventType type, const std::string& messageId) {
    if (messageId.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                        "Message ID cannot be empty");
    }

    EventState currentState = getMessageState(messageId);

    switch (type) {
        case EventType::TextMessageStart:
            if (currentState != EventState::NotStarted && currentState != EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TEXT_MESSAGE_START received for message '" + messageId +
                               "' that is already in progress");
            }
            updateMessageState(messageId, EventState::Started);
            break;

        case EventType::TextMessageContent:
            if (currentState != EventState::Started && currentState != EventState::InProgress) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TEXT_MESSAGE_CONTENT received for message '" + messageId +
                               "' that has not been started");
            }
            updateMessageState(messageId, EventState::InProgress);
            break;

        case EventType::TextMessageEnd:
            if (currentState == EventState::NotStarted) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TEXT_MESSAGE_END received for message '" + messageId +
                               "' that was never started");
            }
            if (currentState == EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TEXT_MESSAGE_END received for message '" + messageId +
                               "' that has already ended");
            }
            updateMessageState(messageId, EventState::Ended);
            break;

        default:
            break;
    }
}

void EventVerifier::verifyThinkingTextMessage(EventType type) {
    switch (type) {
        case EventType::ThinkingTextMessageStart:
            if (m_thinkingTextMessageState != EventState::NotStarted &&
                m_thinkingTextMessageState != EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_TEXT_MESSAGE_START received while thinking message is already in progress");
            }
            m_thinkingTextMessageState = EventState::Started;
            break;

        case EventType::ThinkingTextMessageContent:
            if (m_thinkingTextMessageState != EventState::Started &&
                m_thinkingTextMessageState != EventState::InProgress) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_TEXT_MESSAGE_CONTENT received without THINKING_TEXT_MESSAGE_START");
            }
            m_thinkingTextMessageState = EventState::InProgress;
            break;

        case EventType::ThinkingTextMessageEnd:
            if (m_thinkingTextMessageState == EventState::NotStarted) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_TEXT_MESSAGE_END received without THINKING_TEXT_MESSAGE_START");
            }
            if (m_thinkingTextMessageState == EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_TEXT_MESSAGE_END received for thinking message that has already ended");
            }
            m_thinkingTextMessageState = EventState::Ended;
            break;

        default:
            break;
    }
}

void EventVerifier::verifyToolCall(EventType type, const std::string& toolCallId) {
    if (toolCallId.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                        "Tool call ID cannot be empty");
    }

    EventState currentState = getToolCallState(toolCallId);

    switch (type) {
        case EventType::ToolCallStart:
            if (currentState != EventState::NotStarted && currentState != EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TOOL_CALL_START received for tool call '" + toolCallId +
                               "' that is already in progress");
            }
            updateToolCallState(toolCallId, EventState::Started);
            break;

        case EventType::ToolCallArgs:
            if (currentState != EventState::Started && currentState != EventState::InProgress) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TOOL_CALL_ARGS received for tool call '" + toolCallId +
                               "' that has not been started");
            }
            updateToolCallState(toolCallId, EventState::InProgress);
            break;

        case EventType::ToolCallEnd:
            if (currentState == EventState::NotStarted) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TOOL_CALL_END received for tool call '" + toolCallId +
                               "' that was never started");
            }
            if (currentState == EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "TOOL_CALL_END received for tool call '" + toolCallId +
                               "' that has already ended");
            }
            updateToolCallState(toolCallId, EventState::Ended);
            break;

        default:
            break;
    }
}

void EventVerifier::verifyThinking(EventType type) {
    switch (type) {
        case EventType::ThinkingStart:
            if (m_thinkingState != EventState::NotStarted && m_thinkingState != EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_START received while thinking is already active");
            }
            m_thinkingState = EventState::Started;
            break;

        case EventType::ThinkingEnd:
            if (m_thinkingState == EventState::NotStarted) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_END received without THINKING_START");
            }
            if (m_thinkingState == EventState::Ended) {
                throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                               "THINKING_END received for thinking that has already ended");
            }
            m_thinkingState = EventState::Ended;
            break;

        default:
            break;
    }
}

void EventVerifier::updateMessageState(const std::string& messageId, EventState newState) {
    m_messageStates[messageId] = newState;
}

void EventVerifier::updateToolCallState(const std::string& toolCallId, EventState newState) {
    m_toolCallStates[toolCallId] = newState;
}

void EventVerifier::reset() {
    m_messageStates.clear();
    m_toolCallStates.clear();
    m_thinkingState = EventState::NotStarted;
    m_thinkingTextMessageState = EventState::NotStarted;
}

bool EventVerifier::isComplete() const {
    // Check for incomplete messages
    for (const auto& pair : m_messageStates) {
        if (pair.second != EventState::Ended && pair.second != EventState::NotStarted) {
            return false;
        }
    }

    // Check for incomplete tool calls
    for (const auto& pair : m_toolCallStates) {
        if (pair.second != EventState::Ended && pair.second != EventState::NotStarted) {
            return false;
        }
    }

    // Check thinking states
    if (m_thinkingState != EventState::NotStarted && m_thinkingState != EventState::Ended) {
        return false;
    }

    if (m_thinkingTextMessageState != EventState::NotStarted &&
        m_thinkingTextMessageState != EventState::Ended) {
        return false;
    }

    return true;
}

std::set<std::string> EventVerifier::getIncompleteMessages() const {
    std::set<std::string> incomplete;
    for (const auto& pair : m_messageStates) {
        if (pair.second != EventState::Ended && pair.second != EventState::NotStarted) {
            incomplete.insert(pair.first);
        }
    }
    return incomplete;
}

std::set<std::string> EventVerifier::getIncompleteToolCalls() const {
    std::set<std::string> incomplete;
    for (const auto& pair : m_toolCallStates) {
        if (pair.second != EventState::Ended && pair.second != EventState::NotStarted) {
            incomplete.insert(pair.first);
        }
    }
    return incomplete;
}

EventVerifier::EventState EventVerifier::getMessageState(const std::string& messageId) const {
    auto it = m_messageStates.find(messageId);
    if (it != m_messageStates.end()) {
        return it->second;
    }
    return EventState::NotStarted;
}

EventVerifier::EventState EventVerifier::getToolCallState(const std::string& toolCallId) const {
    auto it = m_toolCallStates.find(toolCallId);
    if (it != m_toolCallStates.end()) {
        return it->second;
    }
    return EventState::NotStarted;
}

bool EventVerifier::isThinkingActive() const {
    return m_thinkingState == EventState::Started || m_thinkingState == EventState::InProgress;
}

}  // namespace agui
