#pragma once

#include <map>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "event.h"

namespace agui {

/**
 * @brief Event sequence verifier for AG-UI protocol compliance
 * 
 * This class validates that events follow the correct lifecycle patterns:
 * - Messages: START → CONTENT* → END
 * - Tool calls: START → ARGS* → END
 * - Thinking: START → CONTENT* → END
 * 
 * Supports concurrent messages and tool calls using unique IDs.
 */
class EventVerifier {
public:
    /**
     * @brief Event state in the lifecycle
     * 
     * State transitions for text messages:
     *   NotStarted --[TEXT_MESSAGE_START]--> Started
     *   Started --[TEXT_MESSAGE_CONTENT]--> InProgress
     *   InProgress --[TEXT_MESSAGE_CONTENT]--> InProgress
     *   Started/InProgress --[TEXT_MESSAGE_END]--> Ended
     *   Ended --[TEXT_MESSAGE_START]--> Started (reusing same ID is allowed)
     * 
     * Same pattern applies to tool calls with TOOL_CALL_START/ARGS/END.
     * 
     * Thinking events use a global singleton state (not ID-tracked).
     */
    enum class EventState {
        NotStarted,    ///< No START event received yet for this ID (initial state)
        Started,       ///< START event received, awaiting CONTENT/ARGS or END
        InProgress,    ///< CONTENT/ARGS events being received (intermediate state)
        Ended          ///< END event received, lifecycle complete (may restart)
    };

    EventVerifier();
    ~EventVerifier();

    // Throws AgentError if the event violates protocol sequence rules.
    void verify(const Event& event);

    // Clears all tracked message and tool call states.
    void reset();

    // Returns true if all started events have received their corresponding END.
    bool isComplete() const;

    std::set<std::string> getIncompleteMessages() const;
    std::set<std::string> getIncompleteToolCalls() const;
    EventState getMessageState(const std::string& messageId) const;
    EventState getToolCallState(const std::string& toolCallId) const;
    bool isThinkingActive() const;

private:
    void verifyTextMessage(EventType type, const std::string& messageId);
    void verifyThinkingTextMessage(EventType type);
    void verifyToolCall(EventType type, const std::string& toolCallId);
    void verifyThinking(EventType type);
    void updateMessageState(const std::string& messageId, EventState newState);
    void updateToolCallState(const std::string& toolCallId, EventState newState);

    // State tracking
    std::map<std::string, EventState> m_messageStates;      // Message ID -> State
    std::map<std::string, EventState> m_toolCallStates;     // Tool Call ID -> State
    EventState m_thinkingState;                              // Global thinking state
    EventState m_thinkingTextMessageState;                   // Thinking text message state
};

}  // namespace agui