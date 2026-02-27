#include "core/subscriber.h"

#include <algorithm>

namespace agui {

// EventHandler implementation

EventHandler::EventHandler(std::vector<Message> messages, const std::string &state, const RunAgentInput& input,
                           std::vector<std::shared_ptr<IAgentSubscriber>> subscribers)
    : m_messages(std::move(messages)),
      m_state(state),
      m_input(input),
      m_subscribers(std::move(subscribers)) {}

AgentStateMutation EventHandler::handleEvent(std::unique_ptr<Event> event) {
    if (!event) {
        return AgentStateMutation();
    }

    EventType type = event->type();

    // Step 1: Invoke generic onEvent callback first
    AgentStateMutation genericMutation = notifySubscribers(
        [&](IAgentSubscriber* sub, const AgentSubscriberParams& params) { return sub->onEvent(*event, params); });

    // Step 2: Check stopPropagation flag
    if (genericMutation.stopPropagation) {
        return genericMutation;
    }

    // Step 3: Execute default event handling
    switch (type) {
        case EventType::TextMessageStart:
            handleTextMessageStart(*static_cast<TextMessageStartEvent*>(event.get()));
            break;
        case EventType::TextMessageContent:
            handleTextMessageContent(*static_cast<TextMessageContentEvent*>(event.get()));
            break;
        case EventType::TextMessageEnd:
            handleTextMessageEnd(*static_cast<TextMessageEndEvent*>(event.get()));
            break;
        case EventType::ThinkingTextMessageStart:
            handleThinkingTextMessageStart(*static_cast<ThinkingTextMessageStartEvent*>(event.get()));
            break;
        case EventType::ThinkingTextMessageContent:
            handleThinkingTextMessageContent(*static_cast<ThinkingTextMessageContentEvent*>(event.get()));
            break;
        case EventType::ThinkingTextMessageEnd:
            handleThinkingTextMessageEnd(*static_cast<ThinkingTextMessageEndEvent*>(event.get()));
            break;
        case EventType::ToolCallStart:
            handleToolCallStart(*static_cast<ToolCallStartEvent*>(event.get()));
            break;
        case EventType::ToolCallArgs:
            handleToolCallArgs(*static_cast<ToolCallArgsEvent*>(event.get()));
            break;
        case EventType::ToolCallEnd:
            handleToolCallEnd(*static_cast<ToolCallEndEvent*>(event.get()));
            break;
        case EventType::ToolCallResult:
            handleToolCallResult(*static_cast<ToolCallResultEvent*>(event.get()));
            break;
        case EventType::StateSnapshot:
            handleStateSnapshot(*static_cast<StateSnapshotEvent*>(event.get()));
            break;
        case EventType::StateDelta:
            handleStateDelta(*static_cast<StateDeltaEvent*>(event.get()));
            break;
        case EventType::MessagesSnapshot:
            handleMessagesSnapshot(*static_cast<MessagesSnapshotEvent*>(event.get()));
            break;
        case EventType::RunStarted:
            handleRunStarted(*static_cast<RunStartedEvent*>(event.get()));
            break;
        case EventType::RunFinished:
            handleRunFinished(*static_cast<RunFinishedEvent*>(event.get()));
            break;
        case EventType::RunError:
            handleRunError(*static_cast<RunErrorEvent*>(event.get()));
            break;

        default:
            break;
    }

    // Step 4: Invoke type-specific subscriber callbacks
    AgentStateMutation specificMutation;

    switch (type) {
        case EventType::TextMessageStart:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onTextMessageStart(*static_cast<TextMessageStartEvent*>(event.get()), params);
            });
            break;

        case EventType::TextMessageContent: {
            auto* e = static_cast<TextMessageContentEvent*>(event.get());
            const std::string& buffer = m_textBuffers[e->messageId];
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onTextMessageContent(*e, buffer, params);
            });
            break;
        }

        case EventType::TextMessageEnd:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onTextMessageEnd(*static_cast<TextMessageEndEvent*>(event.get()), params);
            });
            break;

        case EventType::TextMessageChunk:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onTextMessageChunk(*static_cast<TextMessageChunkEvent*>(event.get()), params);
            });
            break;

        case EventType::ThinkingTextMessageStart:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onThinkingTextMessageStart(*static_cast<ThinkingTextMessageStartEvent*>(event.get()),
                                                       params);
            });
            break;

        case EventType::ThinkingTextMessageContent: {
            auto* e = static_cast<ThinkingTextMessageContentEvent*>(event.get());
            // Use buffer from the last message (thinking messages don't have messageId)
            std::string buffer;
            if (!m_messages.empty()) {
                buffer = m_textBuffers[m_messages.back().id()];
            }
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onThinkingTextMessageContent(*e, buffer, params);
            });
            break;
        }

        case EventType::ThinkingTextMessageEnd:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onThinkingTextMessageEnd(*static_cast<ThinkingTextMessageEndEvent*>(event.get()), params);
            });
            break;

        case EventType::ToolCallStart:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onToolCallStart(*static_cast<ToolCallStartEvent*>(event.get()), params);
            });
            break;

        case EventType::ToolCallArgs: {
            auto* e = static_cast<ToolCallArgsEvent*>(event.get());
            const std::string& buffer = m_toolCallArgsBuffers[e->toolCallId];
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onToolCallArgs(*e, buffer, params);
            });
            break;
        }

        case EventType::ToolCallEnd:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onToolCallEnd(*static_cast<ToolCallEndEvent*>(event.get()), params);
            });
            break;

        case EventType::ToolCallChunk:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onToolCallChunk(*static_cast<ToolCallChunkEvent*>(event.get()), params);
            });
            break;

        case EventType::ToolCallResult:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onToolCallResult(*static_cast<ToolCallResultEvent*>(event.get()), params);
            });
            break;

        case EventType::ThinkingStart:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onThinkingStart(*static_cast<ThinkingStartEvent*>(event.get()), params);
            });
            break;

        case EventType::ThinkingEnd:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onThinkingEnd(*static_cast<ThinkingEndEvent*>(event.get()), params);
            });
            break;

        case EventType::StateSnapshot:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onStateSnapshot(*static_cast<StateSnapshotEvent*>(event.get()), params);
            });
            break;

        case EventType::StateDelta:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onStateDelta(*static_cast<StateDeltaEvent*>(event.get()), params);
            });
            break;

        case EventType::MessagesSnapshot:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onMessagesSnapshot(*static_cast<MessagesSnapshotEvent*>(event.get()), params);
            });
            break;

        case EventType::RunStarted:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onRunStarted(*static_cast<RunStartedEvent*>(event.get()), params);
            });
            break;

        case EventType::RunFinished:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onRunFinished(*static_cast<RunFinishedEvent*>(event.get()), params);
            });
            break;

        case EventType::RunError:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onRunError(*static_cast<RunErrorEvent*>(event.get()), params);
            });
            break;

        case EventType::StepStarted:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onStepStarted(*static_cast<StepStartedEvent*>(event.get()), params);
            });
            break;

        case EventType::StepFinished:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onStepFinished(*static_cast<StepFinishedEvent*>(event.get()), params);
            });
            break;

        case EventType::Raw:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onRawEvent(*static_cast<RawEvent*>(event.get()), params);
            });
            break;

        case EventType::Custom:
            specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                return sub->onCustomEvent(*static_cast<CustomEvent*>(event.get()), params);
            });
            break;
    }

    return specificMutation;
}

void EventHandler::applyMutation(const AgentStateMutation& mutation) {
#if __cplusplus >= 201703L
    if (mutation.messages.has_value()) {
        m_messages = mutation.messages.value();
        notifyMessagesChanged();
    }

    if (mutation.state.has_value()) {
        m_state = mutation.state.value();
        notifyStateChanged();
    }
#else
    if (mutation.messages) {
        m_messages = *mutation.messages;
        notifyMessagesChanged();
    }

    if (mutation.state) {
        m_state = *mutation.state;
        notifyStateChanged();
    }
#endif
}

void EventHandler::addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber) {
    if (subscriber) {
        m_subscribers.push_back(subscriber);
    }
}

void EventHandler::removeSubscriber(std::shared_ptr<IAgentSubscriber> subscriber) {
    m_subscribers.erase(std::remove(m_subscribers.begin(), m_subscribers.end(), subscriber), m_subscribers.end());
}

void EventHandler::clearSubscribers() {
    m_subscribers.clear();
}

void EventHandler::handleTextMessageStart(const TextMessageStartEvent& event) {
    Message message = Message::createAssistant("", event.messageId);
    m_messages.push_back(message);
    m_textBuffers[event.messageId] = "";
    notifyNewMessage(message);
}

void EventHandler::handleTextMessageContent(const TextMessageContentEvent& event) {
    m_textBuffers[event.messageId] += event.delta;
    Message* msg = findMessage(event.messageId);
    if (msg) {
        msg->appendContent(event.delta);
    }
}

void EventHandler::handleTextMessageEnd(const TextMessageEndEvent& event) {
    m_textBuffers.erase(event.messageId);
    notifyMessagesChanged();
}

void EventHandler::handleThinkingTextMessageStart(const ThinkingTextMessageStartEvent& event) {
    MessageId tempId = "thinking_" + std::to_string(std::chrono::system_clock::now().time_since_epoch().count());
    Message message = Message::createAssistant("", tempId);
    m_messages.push_back(message);
    m_textBuffers[tempId] = "";
    notifyNewMessage(message);
}

void EventHandler::handleThinkingTextMessageContent(const ThinkingTextMessageContentEvent& event) {
    if (!m_messages.empty()) {
        Message* msg = &m_messages.back();
        msg->appendContent(event.delta);
        m_textBuffers[msg->id()] += event.delta;
    }
}

void EventHandler::handleThinkingTextMessageEnd(const ThinkingTextMessageEndEvent& event) {
    if (!m_messages.empty()) {
        m_textBuffers.erase(m_messages.back().id());
    }
    notifyMessagesChanged();
}

void EventHandler::handleToolCallStart(const ToolCallStartEvent& event) {
    Message* msg = findMessage(event.parentMessageId);
    if (!msg) {
        Message message = Message::createAssistant("", event.parentMessageId);
        m_messages.push_back(message);
        msg = &m_messages.back();
    }

    ToolCall toolCall;
    toolCall.id = event.toolCallId;
    toolCall.function.name = event.toolCallName;
    toolCall.function.arguments = "";

    msg->addToolCall(toolCall);
    m_toolCallArgsBuffers[event.toolCallId] = "";
    notifyNewToolCall(toolCall);
}

void EventHandler::handleToolCallArgs(const ToolCallArgsEvent& event) {
    m_toolCallArgsBuffers[event.toolCallId] += event.delta;
    ToolCall* toolCall = findToolCall(event.messageId, event.toolCallId);
    if (toolCall) {
        toolCall->function.arguments += event.delta;
    }
}

void EventHandler::handleToolCallEnd(const ToolCallEndEvent& event) {
    m_toolCallArgsBuffers.erase(event.toolCallId);
    notifyMessagesChanged();
}

void EventHandler::handleStateSnapshot(const StateSnapshotEvent& event) {
    m_state = event.snapshot;
    notifyStateChanged();
}

void EventHandler::handleStateDelta(const StateDeltaEvent& event) {
    StateManager stateManager(m_state);
    stateManager.applyPatch(event.delta);
    m_state = stateManager.currentState();
    notifyStateChanged();
}

void EventHandler::handleMessagesSnapshot(const MessagesSnapshotEvent& event) {
    m_messages = event.messages;
    notifyMessagesChanged();
}

void EventHandler::handleRunStarted(const RunStartedEvent& event) {
    (void)event;
}

void EventHandler::handleRunFinished(const RunFinishedEvent& event) {
    if (!event.result.is_null()) {
        m_result = event.result;
    }
}

void EventHandler::handleRunError(const RunErrorEvent& event) {
    (void)event;
}

AgentStateMutation EventHandler::notifySubscribers(
    std::function<AgentStateMutation(IAgentSubscriber*, const AgentSubscriberParams&)> notifyFunc) {
    AgentStateMutation finalMutation;
    AgentSubscriberParams params = createParams();

    for (auto& subscriber : m_subscribers) {
        AgentStateMutation mutation = notifyFunc(subscriber.get(), params);

#if __cplusplus >= 201703L
        if (mutation.messages.has_value()) {
            finalMutation.messages = mutation.messages;
        }
        if (mutation.state.has_value()) {
            finalMutation.state = mutation.state;
        }
#else
        if (mutation.messages) {
            finalMutation.messages.reset(new std::vector<Message>(*mutation.messages));
        }
        if (mutation.state) {
            finalMutation.state.reset(new nlohmann::json(*mutation.state));
        }
#endif

        if (mutation.stopPropagation) {
            finalMutation.stopPropagation = true;
            break;
        }
    }

    return finalMutation;
}

void EventHandler::notifyNewMessage(const Message& message) {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        subscriber->onNewMessage(message, params);
    }
}

void EventHandler::notifyNewToolCall(const ToolCall& toolCall) {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        subscriber->onNewToolCall(toolCall, params);
    }
}

void EventHandler::notifyMessagesChanged() {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        subscriber->onMessagesChanged(params);
    }
}

void EventHandler::notifyStateChanged() {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        subscriber->onStateChanged(params);
    }
}

Message* EventHandler::findMessage(const MessageId& id) {
    for (auto& msg : m_messages) {
        if (msg.id() == id) {
            return &msg;
        }
    }
    return nullptr;
}

ToolCall* EventHandler::findToolCall(const MessageId& messageId, const ToolCallId& toolCallId) {
    Message* msg = findMessage(messageId);
    if (!msg) {
        return nullptr;
    }

    auto& toolCalls = const_cast<std::vector<ToolCall>&>(msg->toolCalls());
    for (size_t i = 0; i < toolCalls.size(); ++i) {
        if (toolCalls[i].id == toolCallId) {
            return &toolCalls[i];
        }
    }

    return nullptr;
}

AgentSubscriberParams EventHandler::createParams() const {
    return AgentSubscriberParams(&m_messages, &m_state, &m_input);
}

void EventHandler::processEventStream(std::vector<std::unique_ptr<Event>> events,
                                      std::function<void(const AgentStateMutation&)> onMutation,
                                      std::function<void()> onComplete,
                                      std::function<void(const AgentError&)> onError) {
    try {
        for (auto& event : events) {
            AgentStateMutation mutation = handleEvent(std::move(event));
            applyMutation(mutation);

            if (mutation.hasChanges()) {
                onMutation(mutation);
            }
        }

        onComplete();

    } catch (const AgentError& e) {
        onError(e);
    } catch (const std::exception& e) {
        AgentError error;
        // TODO: process error
    }
}

void EventHandler::handleToolCallResult(const ToolCallResultEvent& event) {
    Message toolMessage = Message::createTool(event.toolCallId, event.result);
    m_messages.push_back(toolMessage);
    notifyNewMessage(toolMessage);
    notifyMessagesChanged();
}

}  // namespace agui
