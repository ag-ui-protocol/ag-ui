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
        // Text message events
        case EventType::TextMessageStart:
        case EventType::TextMessageContent:
        case EventType::TextMessageEnd: {
            const auto* startEvent = static_cast<const TextMessageStartEvent*>(&event);
            const auto* contentEvent = static_cast<const TextMessageContentEvent*>(&event);
            const auto* endEvent = static_cast<const TextMessageEndEvent*>(&event);
            std::string messageId;
            
            if (startEvent) {
                messageId = startEvent->messageId;
            } else if (contentEvent) {
                messageId = contentEvent->messageId;
            } else if (endEvent) {
                messageId = endEvent->messageId;
            }
            
            verifyTextMessage(eventType, messageId);
            break;
        }

        // Thinking text message events
        case EventType::ThinkingTextMessageStart:
        case EventType::ThinkingTextMessageContent:
        case EventType::ThinkingTextMessageEnd:
            verifyThinkingTextMessage(eventType);
            break;

        // Tool call events
        case EventType::ToolCallStart:
        case EventType::ToolCallArgs:
        case EventType::ToolCallEnd: {
            const auto* startEvent = static_cast<const ToolCallStartEvent*>(&event);
            const auto* argsEvent = static_cast<const ToolCallArgsEvent*>(&event);
            const auto* endEvent = static_cast<const ToolCallEndEvent*>(&event);
            std::string toolCallId;
            
            if (startEvent) {
                toolCallId = startEvent->toolCallId;
            } else if (argsEvent) {
                toolCallId = argsEvent->toolCallId;
            } else if (endEvent) {
                toolCallId = endEvent->toolCallId;
            }
            
            verifyToolCall(eventType, toolCallId);
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