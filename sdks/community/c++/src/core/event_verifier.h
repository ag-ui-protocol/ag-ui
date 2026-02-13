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
     */
    enum class EventState {
        NotStarted,    // Event has not started yet
        Started,       // START event received
        InProgress,    // CONTENT/ARGS events being received
        Ended          // END event received
    };

    /**
     * @brief Constructor
     */
    EventVerifier();

    /**
     * @brief Destructor
     */
    ~EventVerifier();

    /**
     * @brief Verify an event follows the correct sequence
     * 
     * @param event The event to verify
     * @throws AgentError if the event violates the sequence rules
     */
    void verify(const Event& event);

    /**
     * @brief Reset the verifier state
     * 
     * Clears all tracked message and tool call states.
     */
    void reset();

    /**
     * @brief Check if there are any incomplete events
     * 
     * @return true if all started events have been properly ended
     */
    bool isComplete() const;

    /**
     * @brief Get the list of incomplete message IDs
     * 
     * @return Set of message IDs that have been started but not ended
     */
    std::set<std::string> getIncompleteMessages() const;

    /**
     * @brief Get the list of incomplete tool call IDs
     * 
     * @return Set of tool call IDs that have been started but not ended
     */
    std::set<std::string> getIncompleteToolCalls() const;

    /**
     * @brief Get the current state of a message
     * 
     * @param messageId The message ID to query
     * @return The current state of the message
     */
    EventState getMessageState(const std::string& messageId) const;

    /**
     * @brief Get the current state of a tool call
     * 
     * @param toolCallId The tool call ID to query
     * @return The current state of the tool call
     */
    EventState getToolCallState(const std::string& toolCallId) const;

    /**
     * @brief Check if thinking is currently active
     * 
     * @return true if THINKING_START has been received without THINKING_END
     */
    bool isThinkingActive() const;

private:
    /**
     * @brief Verify a text message event
     */
    void verifyTextMessage(EventType type, const std::string& messageId);

    /**
     * @brief Verify a thinking text message event
     */
    void verifyThinkingTextMessage(EventType type);

    /**
     * @brief Verify a tool call event
     */
    void verifyToolCall(EventType type, const std::string& toolCallId);

    /**
     * @brief Verify a thinking event
     */
    void verifyThinking(EventType type);

    /**
     * @brief Update message state
     */
    void updateMessageState(const std::string& messageId, EventState newState);

    /**
     * @brief Update tool call state
     */
    void updateToolCallState(const std::string& toolCallId, EventState newState);

    // State tracking
    std::map<std::string, EventState> m_messageStates;      // Message ID -> State
    std::map<std::string, EventState> m_toolCallStates;     // Tool Call ID -> State
    EventState m_thinkingState;                              // Global thinking state
    EventState m_thinkingTextMessageState;                   // Thinking text message state
};

}  // namespace agui