#pragma once

#include <cstddef>
#include <functional>
#include <map>
#include <memory>
#include <unordered_map>
#include <vector>

#include <optional>

#include "core/error.h"
#include "core/event.h"
#include "core/session_types.h"
#include "core/state.h"

namespace agui {

struct AgentStateMutation {
    std::optional<std::vector<Message>> messages;
    std::optional<nlohmann::json> state;
    bool stopPropagation = false;

    AgentStateMutation& withMessages(const std::vector<Message>& msgs) {
        messages = msgs;
        return *this;
    }

    AgentStateMutation& withState(const nlohmann::json& s) {
        state = s;
        return *this;
    }

    AgentStateMutation& withStopPropagation(bool stop) {
        stopPropagation = stop;
        return *this;
    }

    bool hasChanges() const {
        return messages.has_value() || state.has_value();
    }
};

struct AgentSubscriberParams {
    const std::vector<Message>* messages = nullptr;
    const nlohmann::json* state = nullptr;

    AgentSubscriberParams() {}

    AgentSubscriberParams(const std::vector<Message>* msgs, const nlohmann::json* st)
        : messages(msgs), state(st) {}
};

class IAgentSubscriber {
public:
    virtual ~IAgentSubscriber() = default;

    virtual AgentStateMutation onEvent(const Event& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                                  const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event, const std::string& buffer,
                                                    const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onTextMessageChunk(const TextMessageChunkEvent& event,
                                                  const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onThinkingTextMessageStart(const ThinkingTextMessageStartEvent& event,
                                                          const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onThinkingTextMessageContent(const ThinkingTextMessageContentEvent& event,
                                                            const std::string& buffer,
                                                            const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onThinkingTextMessageEnd(const ThinkingTextMessageEndEvent& event,
                                                        const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onToolCallStart(const ToolCallStartEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onToolCallArgs(const ToolCallArgsEvent& event, const std::string& buffer,
                                              const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onToolCallEnd(const ToolCallEndEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onToolCallChunk(const ToolCallChunkEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onToolCallResult(const ToolCallResultEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onThinkingStart(const ThinkingStartEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onThinkingEnd(const ThinkingEndEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onStateSnapshot(const StateSnapshotEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onStateDelta(const StateDeltaEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onMessagesSnapshot(const MessagesSnapshotEvent& event,
                                                  const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onRunStarted(const RunStartedEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onRunFinished(const RunFinishedEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onRunError(const RunErrorEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onStepStarted(const StepStartedEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onStepFinished(const StepFinishedEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onActivitySnapshot(const ActivitySnapshotEvent& event,
                                                   const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onActivityDelta(const ActivityDeltaEvent& event,
                                               const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onRawEvent(const RawEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual AgentStateMutation onCustomEvent(const CustomEvent& event, const AgentSubscriberParams& params) {
        return AgentStateMutation();
    }

    virtual void onNewMessage(const Message& message, const AgentSubscriberParams& params) {}

    virtual void onNewToolCall(const ToolCall& toolCall, const AgentSubscriberParams& params) {}

    virtual void onMessagesChanged(const AgentSubscriberParams& params) {}

    virtual void onStateChanged(const AgentSubscriberParams& params) {}

    virtual void onRunFailed(const AgentError& error, const AgentSubscriberParams& params) {}

    virtual void onRunFinalized(const AgentSubscriberParams& params) {}
};

/**
 * @class EventHandler
 * @brief Handles AG-UI protocol events and manages agent state
 * 
 * @warning Thread Safety: NOT thread-safe
 * All methods must be called from the same thread. For multi-threaded use,
 * provide external synchronization (e.g., std::mutex) or use a message queue
 * to serialize events to a single processing thread.
 */
class EventHandler {
public:
    EventHandler(std::vector<Message> messages, const nlohmann::json &state,
                 std::vector<std::shared_ptr<IAgentSubscriber>> subscribers = {});

    AgentStateMutation handleEvent(std::unique_ptr<Event> event);
    void applyMutation(const AgentStateMutation& mutation);
    void addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber);
    void removeSubscriber(std::shared_ptr<IAgentSubscriber> subscriber);
    void clearSubscribers();

    /**
     * @brief Clear all per-message streaming buffers.
     *        Call at the start of each run to prevent stale data from a prior run leaking into the next.
     */
    void clearBuffers();

    void notifyRunFailed(const AgentError& error);
    void notifyRunFinalized();

    const std::vector<Message>& messages() const { return m_messages; }
    const nlohmann::json& state() const { return m_state; }
    const std::string& result() const { return m_result; }

    void setResult(const nlohmann::json& result) { m_result = result.dump(); }
    void clearResult() { m_result.clear(); }

private:
    std::vector<Message> m_messages;
    std::vector<std::shared_ptr<IAgentSubscriber>> m_subscribers;
    nlohmann::json m_state = nlohmann::json::object();
    std::string m_result;

    std::map<MessageId, std::string> m_textBuffers;
    std::map<ToolCallId, std::string> m_toolCallArgsBuffers;
    std::string m_thinkingBuffer;
    MessageId m_lastTextChunkMessageId;
    ToolCallId m_lastToolCallChunkId;

    // O(1) lookup indices — kept in sync with m_messages
    std::unordered_map<MessageId, size_t> m_messageIndex;           ///< messageId → m_messages index
    std::unordered_map<ToolCallId, size_t> m_toolCallToMessageIndex; ///< toolCallId → m_messages index

    void handleTextMessageStart(const TextMessageStartEvent& event);
    void handleTextMessageContent(const TextMessageContentEvent& event);
    void handleTextMessageEnd(const TextMessageEndEvent& event);
    void handleTextMessageChunk(const TextMessageChunkEvent& event);
    void handleThinkingTextMessageStart(const ThinkingTextMessageStartEvent& event);
    void handleThinkingTextMessageContent(const ThinkingTextMessageContentEvent& event);
    void handleThinkingTextMessageEnd(const ThinkingTextMessageEndEvent& event);

    void handleToolCallStart(const ToolCallStartEvent& event);
    void handleToolCallArgs(const ToolCallArgsEvent& event);
    void handleToolCallEnd(const ToolCallEndEvent& event);
    void handleToolCallChunk(const ToolCallChunkEvent& event);
    void handleToolCallResult(const ToolCallResultEvent& event);

    void handleStateSnapshot(const StateSnapshotEvent& event);
    void handleStateDelta(const StateDeltaEvent& event);
    void handleMessagesSnapshot(const MessagesSnapshotEvent& event);

    void handleRunStarted(const RunStartedEvent& event);
    void handleRunFinished(const RunFinishedEvent& event);
    void handleRunError(const RunErrorEvent& event);

    void handleActivitySnapshot(const ActivitySnapshotEvent& event);
    void handleActivityDelta(const ActivityDeltaEvent& event);

    AgentStateMutation notifySubscribers(
        std::function<AgentStateMutation(IAgentSubscriber*, const AgentSubscriberParams&)> notifyFunc);

    void notifyNewMessage(const Message& message);
    void notifyNewToolCall(const ToolCall& toolCall);
    void notifyMessagesChanged();
    void notifyStateChanged();

    Message* findMessage(const MessageId& id);
    Message* findMessageContainingToolCall(const ToolCallId& toolCallId);
    void appendEventDelta(const ToolCallId& toolCallId, const std::string &delta);
    AgentSubscriberParams createParams() const;
    void rebuildMessageIndex();
};

}  // namespace agui
