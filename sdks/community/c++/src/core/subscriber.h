#pragma once

#include <functional>
#include <memory>
#include <vector>

#if __cplusplus >= 201703L
#include <optional>
#endif

#include "core/error.h"
#include "core/event.h"
#include "core/session_types.h"
#include "core/state.h"

namespace agui {

class IAgentSubscriber;
class EventHandler;

struct AgentStateMutation {
#if __cplusplus >= 201703L
    std::optional<std::vector<Message>> messages;
    std::optional<nlohmann::json> state;
#else
    std::unique_ptr<std::vector<Message>> messages;
    std::unique_ptr<nlohmann::json> state;
#endif
    bool stopPropagation;

    AgentStateMutation() : stopPropagation(false) {}

    AgentStateMutation& withMessages(const std::vector<Message>& msgs) {
#if __cplusplus >= 201703L
        messages = msgs;
#else
        messages.reset(new std::vector<Message>(msgs));
#endif
        return *this;
    }

    AgentStateMutation& withState(const nlohmann::json& s) {
#if __cplusplus >= 201703L
        state = s;
#else
        state.reset(new nlohmann::json(s));
#endif
        return *this;
    }

    AgentStateMutation& withStopPropagation(bool stop) {
        stopPropagation = stop;
        return *this;
    }

    bool hasChanges() const {
#if __cplusplus >= 201703L
        return messages.has_value() || state.has_value();
#else
        return (messages != nullptr) || (state != nullptr);
#endif
    }
};

struct AgentSubscriberParams {
    const std::vector<Message>* messages;
    const std::string* state;
    const RunAgentInput* input;

    AgentSubscriberParams() : messages(nullptr), state(nullptr), input(nullptr) {}

    AgentSubscriberParams(const std::vector<Message>* msgs, const std::string* st, const RunAgentInput* inp)
        : messages(msgs), state(st), input(inp) {}
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

class EventHandler {
public:
    EventHandler(std::vector<Message> messages, const std::string &state, const RunAgentInput& input,
                 std::vector<std::shared_ptr<IAgentSubscriber>> subscribers = {});

    AgentStateMutation handleEvent(std::unique_ptr<Event> event);
    void applyMutation(const AgentStateMutation& mutation);
    void addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber);
    void removeSubscriber(std::shared_ptr<IAgentSubscriber> subscriber);
    void clearSubscribers();

    // Process event stream (batch processing)
    void processEventStream(std::vector<std::unique_ptr<Event>> events,
                            std::function<void(const AgentStateMutation&)> onMutation,
                            std::function<void()> onComplete, std::function<void(const AgentError&)> onError);

    const std::vector<Message>& messages() const { return m_messages; }
    const std::string& state() const { return m_state; }
    const std::string& result() const { return m_result; }
    const RunAgentInput& input() const { return m_input; }

    void setResult(const nlohmann::json& result) { m_result = result; }

private:
    std::vector<Message> m_messages;
    std::string m_state;
    const RunAgentInput& m_input;
    std::vector<std::shared_ptr<IAgentSubscriber>> m_subscribers;
    std::string m_result;

    std::map<MessageId, std::string> m_textBuffers;
    std::map<ToolCallId, std::string> m_toolCallArgsBuffers;

    void handleTextMessageStart(const TextMessageStartEvent& event);
    void handleTextMessageContent(const TextMessageContentEvent& event);
    void handleTextMessageEnd(const TextMessageEndEvent& event);

    void handleThinkingTextMessageStart(const ThinkingTextMessageStartEvent& event);
    void handleThinkingTextMessageContent(const ThinkingTextMessageContentEvent& event);
    void handleThinkingTextMessageEnd(const ThinkingTextMessageEndEvent& event);

    void handleToolCallStart(const ToolCallStartEvent& event);
    void handleToolCallArgs(const ToolCallArgsEvent& event);
    void handleToolCallEnd(const ToolCallEndEvent& event);
    void handleToolCallResult(const ToolCallResultEvent& event);  // NEW: Add TOOL_CALL_RESULT handler

    void handleStateSnapshot(const StateSnapshotEvent& event);
    void handleStateDelta(const StateDeltaEvent& event);
    void handleMessagesSnapshot(const MessagesSnapshotEvent& event);

    void handleRunStarted(const RunStartedEvent& event);
    void handleRunFinished(const RunFinishedEvent& event);
    void handleRunError(const RunErrorEvent& event);

    AgentStateMutation notifySubscribers(
        std::function<AgentStateMutation(IAgentSubscriber*, const AgentSubscriberParams&)> notifyFunc);

    void notifyNewMessage(const Message& message);
    void notifyNewToolCall(const ToolCall& toolCall);
    void notifyMessagesChanged();
    void notifyStateChanged();

    Message* findMessage(const MessageId& id);
    ToolCall* findToolCall(const MessageId& messageId, const ToolCallId& toolCallId);
    AgentSubscriberParams createParams() const;
};

}  // namespace agui
