#include "core/subscriber.h"
#include "logger.h"
#include <algorithm>

namespace agui {

namespace {

[[noreturn]] void throwSubscriberFailure(const char* stage, const std::exception& e) {
    throw AGUI_ERROR(execution, ErrorCode::ExecutionAgentFailed,
                     std::string("Subscriber callback failed during ") + stage + ": " + e.what());
}

[[noreturn]] void throwUnknownSubscriberFailure(const char* stage) {
    throw AGUI_ERROR(execution, ErrorCode::ExecutionAgentFailed,
                     std::string("Subscriber callback failed during ") + stage + ": unknown exception");
}

[[noreturn]] void throwInvalidChunkEvent(const char* eventType, const std::string& reason) {
    throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                     std::string(eventType) + " is missing required context: " + reason);
}

AgentStateMutation mergeMutations(const AgentStateMutation& first, const AgentStateMutation& second) {
    AgentStateMutation merged;
    if (first.messages.has_value()) {
        merged.messages = first.messages;
    }
    if (first.state.has_value()) {
        merged.state = first.state;
    }

    if (second.messages.has_value()) {
        merged.messages = second.messages;
    }
    if (second.state.has_value()) {
        merged.state = second.state;
    }

    merged.stopPropagation = first.stopPropagation || second.stopPropagation;
    return merged;
}

}  // namespace

// EventHandler implementation
EventHandler::EventHandler(std::vector<Message> messages, const nlohmann::json &state,
                           std::vector<std::shared_ptr<IAgentSubscriber>> subscribers)
    : m_messages(std::move(messages)),
      m_subscribers(std::move(subscribers)),
      m_state(state.is_null() ? nlohmann::json::object() : state) {
    rebuildMessageIndex();
}

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
    // Use dynamic_cast to safely downcast; a null result means the concrete type
    // does not match the enum (e.g. a middleware returned a mismatched event object),
    // in which case we skip the handler rather than invoking undefined behaviour.
#define AGUI_HANDLE_EVENT(EventClass, handler) \
    { auto* e = dynamic_cast<EventClass*>(event.get()); \
      if (e) { handler(*e); } \
      else { Logger::warningf("handleEvent: dynamic_cast to " #EventClass " failed, skipping handler"); } }

    switch (type) {
        case EventType::TextMessageStart:
            AGUI_HANDLE_EVENT(TextMessageStartEvent, handleTextMessageStart)
            break;
        case EventType::TextMessageContent:
            AGUI_HANDLE_EVENT(TextMessageContentEvent, handleTextMessageContent)
            break;
        case EventType::TextMessageEnd:
            AGUI_HANDLE_EVENT(TextMessageEndEvent, handleTextMessageEnd)
            break;
        case EventType::TextMessageChunk:
            AGUI_HANDLE_EVENT(TextMessageChunkEvent, handleTextMessageChunk)
            break;
        case EventType::ThinkingTextMessageStart:
            AGUI_HANDLE_EVENT(ThinkingTextMessageStartEvent, handleThinkingTextMessageStart)
            break;
        case EventType::ThinkingTextMessageContent:
            AGUI_HANDLE_EVENT(ThinkingTextMessageContentEvent, handleThinkingTextMessageContent)
            break;
        case EventType::ThinkingTextMessageEnd:
            AGUI_HANDLE_EVENT(ThinkingTextMessageEndEvent, handleThinkingTextMessageEnd)
            break;
        case EventType::ToolCallStart:
            AGUI_HANDLE_EVENT(ToolCallStartEvent, handleToolCallStart)
            break;
        case EventType::ToolCallArgs:
            AGUI_HANDLE_EVENT(ToolCallArgsEvent, handleToolCallArgs)
            break;
        case EventType::ToolCallEnd:
            AGUI_HANDLE_EVENT(ToolCallEndEvent, handleToolCallEnd)
            break;
        case EventType::ToolCallChunk:
            AGUI_HANDLE_EVENT(ToolCallChunkEvent, handleToolCallChunk)
            break;
        case EventType::ToolCallResult:
            AGUI_HANDLE_EVENT(ToolCallResultEvent, handleToolCallResult)
            break;
        case EventType::StateSnapshot:
            AGUI_HANDLE_EVENT(StateSnapshotEvent, handleStateSnapshot)
            break;
        case EventType::StateDelta:
            AGUI_HANDLE_EVENT(StateDeltaEvent, handleStateDelta)
            break;
        case EventType::MessagesSnapshot:
            AGUI_HANDLE_EVENT(MessagesSnapshotEvent, handleMessagesSnapshot)
            break;
        case EventType::RunStarted:
            AGUI_HANDLE_EVENT(RunStartedEvent, handleRunStarted)
            break;
        case EventType::RunFinished:
            AGUI_HANDLE_EVENT(RunFinishedEvent, handleRunFinished)
            break;
        case EventType::RunError:
            AGUI_HANDLE_EVENT(RunErrorEvent, handleRunError)
            break;
        case EventType::ActivitySnapshot:
            AGUI_HANDLE_EVENT(ActivitySnapshotEvent, handleActivitySnapshot)
            break;
        case EventType::ActivityDelta:
            AGUI_HANDLE_EVENT(ActivityDeltaEvent, handleActivityDelta)
            break;

        default:
            break;
    }
#undef AGUI_HANDLE_EVENT

    // Step 4: Invoke type-specific subscriber callbacks
    AgentStateMutation specificMutation;

#define AGUI_NOTIFY_EVENT(EventClass, callback) \
    { auto* e = dynamic_cast<EventClass*>(event.get()); \
      if (e) { \
          specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) { \
              return sub->callback(*e, params); \
          }); \
      } else { \
          Logger::warningf("handleEvent: dynamic_cast to " #EventClass " failed in Step 4, skipping subscribers"); \
      } }

    switch (type) {
        case EventType::TextMessageStart:
            AGUI_NOTIFY_EVENT(TextMessageStartEvent, onTextMessageStart)
            break;

        case EventType::TextMessageContent: {
            auto* e = dynamic_cast<TextMessageContentEvent*>(event.get());
            if (e) {
                const std::string& buffer = m_textBuffers[e->messageId];
                specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                    return sub->onTextMessageContent(*e, buffer, params);
                });
            } else {
                Logger::warningf("handleEvent: dynamic_cast to TextMessageContentEvent failed in Step 4, skipping subscribers");
            }
            break;
        }

        case EventType::TextMessageEnd:
            AGUI_NOTIFY_EVENT(TextMessageEndEvent, onTextMessageEnd)
            break;

        case EventType::TextMessageChunk:
            AGUI_NOTIFY_EVENT(TextMessageChunkEvent, onTextMessageChunk)
            break;

        case EventType::ThinkingTextMessageStart:
            AGUI_NOTIFY_EVENT(ThinkingTextMessageStartEvent, onThinkingTextMessageStart)
            break;

        case EventType::ThinkingTextMessageContent: {
            auto* e = dynamic_cast<ThinkingTextMessageContentEvent*>(event.get());
            if (e) {
                specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                    return sub->onThinkingTextMessageContent(*e, m_thinkingBuffer, params);
                });
            } else {
                Logger::warningf("handleEvent: dynamic_cast to ThinkingTextMessageContentEvent failed in Step 4, skipping subscribers");
            }
            break;
        }

        case EventType::ThinkingTextMessageEnd:
            AGUI_NOTIFY_EVENT(ThinkingTextMessageEndEvent, onThinkingTextMessageEnd)
            break;

        case EventType::ToolCallStart:
            AGUI_NOTIFY_EVENT(ToolCallStartEvent, onToolCallStart)
            break;

        case EventType::ToolCallArgs: {
            auto* e = dynamic_cast<ToolCallArgsEvent*>(event.get());
            if (e) {
                const std::string& buffer = m_toolCallArgsBuffers[e->toolCallId];
                specificMutation = notifySubscribers([&](IAgentSubscriber* sub, const AgentSubscriberParams& params) {
                    return sub->onToolCallArgs(*e, buffer, params);
                });
            } else {
                Logger::warningf("handleEvent: dynamic_cast to ToolCallArgsEvent failed in Step 4, skipping subscribers");
            }
            break;
        }

        case EventType::ToolCallEnd:
            AGUI_NOTIFY_EVENT(ToolCallEndEvent, onToolCallEnd)
            break;

        case EventType::ToolCallChunk:
            AGUI_NOTIFY_EVENT(ToolCallChunkEvent, onToolCallChunk)
            break;

        case EventType::ToolCallResult:
            AGUI_NOTIFY_EVENT(ToolCallResultEvent, onToolCallResult)
            break;

        case EventType::ThinkingStart:
            AGUI_NOTIFY_EVENT(ThinkingStartEvent, onThinkingStart)
            break;

        case EventType::ThinkingEnd:
            AGUI_NOTIFY_EVENT(ThinkingEndEvent, onThinkingEnd)
            break;

        case EventType::StateSnapshot:
            AGUI_NOTIFY_EVENT(StateSnapshotEvent, onStateSnapshot)
            break;

        case EventType::StateDelta:
            AGUI_NOTIFY_EVENT(StateDeltaEvent, onStateDelta)
            break;

        case EventType::MessagesSnapshot:
            AGUI_NOTIFY_EVENT(MessagesSnapshotEvent, onMessagesSnapshot)
            break;

        case EventType::RunStarted:
            AGUI_NOTIFY_EVENT(RunStartedEvent, onRunStarted)
            break;

        case EventType::RunFinished:
            AGUI_NOTIFY_EVENT(RunFinishedEvent, onRunFinished)
            break;

        case EventType::RunError:
            AGUI_NOTIFY_EVENT(RunErrorEvent, onRunError)
            break;

        case EventType::ActivitySnapshot:
            AGUI_NOTIFY_EVENT(ActivitySnapshotEvent, onActivitySnapshot)
            break;

        case EventType::ActivityDelta:
            AGUI_NOTIFY_EVENT(ActivityDeltaEvent, onActivityDelta)
            break;

        case EventType::StepStarted:
            AGUI_NOTIFY_EVENT(StepStartedEvent, onStepStarted)
            break;

        case EventType::StepFinished:
            AGUI_NOTIFY_EVENT(StepFinishedEvent, onStepFinished)
            break;

        case EventType::Raw:
            AGUI_NOTIFY_EVENT(RawEvent, onRawEvent)
            break;

        case EventType::Custom:
            AGUI_NOTIFY_EVENT(CustomEvent, onCustomEvent)
            break;

        default:
            break;
    }
#undef AGUI_NOTIFY_EVENT

    // Generic onEvent() and type-specific callbacks are both allowed to
    // request state/message overrides. Specific callbacks run later and take
    // precedence on conflicting fields.
    return mergeMutations(genericMutation, specificMutation);
}

void EventHandler::applyMutation(const AgentStateMutation& mutation) {
    if (mutation.messages.has_value()) {
        m_messages = mutation.messages.value();
        rebuildMessageIndex();
        notifyMessagesChanged();
    }

    if (mutation.state.has_value()) {
        m_state = mutation.state.value();
        notifyStateChanged();
    }
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

void EventHandler::clearBuffers() {
    m_textBuffers.clear();
    m_toolCallArgsBuffers.clear();
    m_thinkingBuffer.clear();
    m_lastTextChunkMessageId.clear();
    m_lastToolCallChunkId.clear();
}

void EventHandler::handleTextMessageStart(const TextMessageStartEvent& event) {
    Message* existingMessage = findMessage(event.messageId);
    if (!existingMessage) {
        Message message = Message::createWithId(
            event.messageId, event.role.value_or(MessageRole::Assistant), "");
        m_messages.push_back(message);
        m_messageIndex[event.messageId] = m_messages.size() - 1;
        notifyNewMessage(m_messages.back());
        notifyMessagesChanged();
    } else {
        existingMessage->setRole(event.role.value_or(MessageRole::Assistant));
    }
    m_textBuffers[event.messageId] = "";
}

void EventHandler::handleTextMessageContent(const TextMessageContentEvent& event) {
    m_textBuffers[event.messageId] += event.delta;
    Message* msg = findMessage(event.messageId);
    if (msg) {
        msg->appendContent(event.delta);
    } else {
        Logger::warningf("handleTextMessageContent: message '", event.messageId,
                         "' not found; delta discarded (TEXT_MESSAGE_CONTENT before TEXT_MESSAGE_START?)");
    }
}

void EventHandler::handleTextMessageEnd(const TextMessageEndEvent& event) {
    m_textBuffers.erase(event.messageId);
    notifyMessagesChanged();
}

void EventHandler::handleTextMessageChunk(const TextMessageChunkEvent& event) {
    const MessageId targetMessageId = event.messageId.empty() ? m_lastTextChunkMessageId : event.messageId;
    if (targetMessageId.empty()) {
        throwInvalidChunkEvent("TEXT_MESSAGE_CHUNK", "messageId was omitted before any text chunk established context");
    }

    m_lastTextChunkMessageId = targetMessageId;

    Message* message = findMessage(targetMessageId);
    if (!message) {
        Message newMessage = Message::createWithId(
            targetMessageId,
            event.role.value_or(MessageRole::Assistant),
            "");
        if (event.name.has_value()) {
            newMessage.setName(event.name.value());
        }
        m_messages.push_back(newMessage);
        m_messageIndex[targetMessageId] = m_messages.size() - 1;
        notifyNewMessage(m_messages.back());
        message = &m_messages.back();
    } else if (event.role.has_value()) {
        message->setRole(event.role.value());
    }

    if (event.name.has_value()) {
        message->setName(event.name.value());
    }

    m_textBuffers[targetMessageId] += event.delta;
    message->appendContent(event.delta);
}

void EventHandler::handleThinkingTextMessageStart(const ThinkingTextMessageStartEvent&) {
    // Thinking messages are not persisted to message history; clear the dedicated buffer
    m_thinkingBuffer.clear();
}

void EventHandler::handleThinkingTextMessageContent(const ThinkingTextMessageContentEvent& event) {
    m_thinkingBuffer += event.delta;
}

void EventHandler::handleThinkingTextMessageEnd(const ThinkingTextMessageEndEvent&) {
    m_thinkingBuffer.clear();
}

void EventHandler::handleToolCallStart(const ToolCallStartEvent& event) {
    Message* msg = nullptr;

    // Full scan: parentMessageId may refer to any message in history, not just the last one.
    if (event.parentMessageId.has_value()) {
        msg = findMessage(event.parentMessageId.value());
    }

    if (!msg) {
        const MessageId targetMessageId =
            event.parentMessageId.has_value() ? event.parentMessageId.value() : event.toolCallId;
        Message message = Message::createWithId(targetMessageId, MessageRole::Assistant, "");
        m_messages.push_back(message);
        m_messageIndex[targetMessageId] = m_messages.size() - 1;
        msg = &m_messages.back();
        notifyNewMessage(*msg);
    }

    ToolCall toolCall;
    toolCall.id = event.toolCallId;
    toolCall.function.name = event.toolCallName;
    toolCall.function.arguments = "";

    msg->addToolCall(toolCall);
    m_toolCallToMessageIndex[event.toolCallId] = m_messageIndex.at(msg->id());
    m_toolCallArgsBuffers[event.toolCallId] = "";
    notifyNewToolCall(toolCall);
}

void EventHandler::handleToolCallArgs(const ToolCallArgsEvent& event) {
    m_toolCallArgsBuffers[event.toolCallId] += event.delta;
    appendEventDelta(event.toolCallId, event.delta);
}

void EventHandler::handleToolCallEnd(const ToolCallEndEvent& event) {
    m_toolCallArgsBuffers.erase(event.toolCallId);
    notifyMessagesChanged();
}

void EventHandler::handleToolCallChunk(const ToolCallChunkEvent& event) {
    const ToolCallId targetToolCallId = event.toolCallId.empty() ? m_lastToolCallChunkId : event.toolCallId;
    if (targetToolCallId.empty()) {
        throwInvalidChunkEvent("TOOL_CALL_CHUNK", "toolCallId was omitted before any tool call chunk established context");
    }

    m_lastToolCallChunkId = targetToolCallId;

    Message* targetMessage = findMessageContainingToolCall(targetToolCallId);
    if (!targetMessage) {
        if (!event.toolCallName.has_value()) {
            throwInvalidChunkEvent("TOOL_CALL_CHUNK",
                                   "toolCallName is required when the target tool call does not already exist");
        }

        if (event.parentMessageId.has_value()) {
            targetMessage = findMessage(event.parentMessageId.value());
        }

        if (!targetMessage) {
            const MessageId targetMessageId =
                event.parentMessageId.has_value() ? event.parentMessageId.value() : targetToolCallId;
            Message message = Message::createWithId(targetMessageId, MessageRole::Assistant, "");
            m_messages.push_back(message);
            m_messageIndex[targetMessageId] = m_messages.size() - 1;
            targetMessage = &m_messages.back();
            notifyNewMessage(*targetMessage);
        }

        ToolCall toolCall;
        toolCall.id = targetToolCallId;
        toolCall.function.name = event.toolCallName.value();
        toolCall.function.arguments = "";
        targetMessage->addToolCall(toolCall);
        m_toolCallToMessageIndex[targetToolCallId] = m_messageIndex.at(targetMessage->id());
        notifyNewToolCall(toolCall);
    }

    m_toolCallArgsBuffers[targetToolCallId] += event.delta;
    appendEventDelta(targetToolCallId, event.delta);
}

void EventHandler::handleStateSnapshot(const StateSnapshotEvent& event) {
    m_state = event.snapshot;
    notifyStateChanged();
}

void EventHandler::handleStateDelta(const StateDeltaEvent& event) {
    // Re-throw on failure: a state divergence is a fatal condition. The caller
    // (processAvailableEvents) will catch it and terminate the run with an error.
    StateManager stateManager(m_state);
    stateManager.applyPatch(event.delta);
    m_state = stateManager.currentState();
    notifyStateChanged();
}

void EventHandler::handleMessagesSnapshot(const MessagesSnapshotEvent& event) {
    m_messages = event.messages;
    rebuildMessageIndex();
    notifyMessagesChanged();
}

void EventHandler::handleRunStarted(const RunStartedEvent&) {
}

void EventHandler::handleRunFinished(const RunFinishedEvent& event) {
    if (!event.result.is_null()) {
        m_result = event.result.dump();
    }
}

void EventHandler::handleRunError(const RunErrorEvent& event) {
    // Log the structured error so it appears in diagnostics even if no subscriber
    // overrides onRunError().  The caller (HttpAgent) also sets m_runErrorOccurred
    // to redirect the terminal notification through notifyRunFailed() rather than
    // notifyRunFinalized(), ensuring onRunFailed() fires instead of onRunFinalized().
    Logger::errorf("Run error received: ", event.message,
                   event.code.has_value() ? " (code: " + *event.code + ")" : "");
}

AgentStateMutation EventHandler::notifySubscribers(
    std::function<AgentStateMutation(IAgentSubscriber*, const AgentSubscriberParams&)> notifyFunc) {
    AgentStateMutation finalMutation;
    AgentSubscriberParams params = createParams();

    for (auto& subscriber : m_subscribers) {
        try {
            AgentStateMutation mutation = notifyFunc(subscriber.get(), params);
            
            if (mutation.messages.has_value()) {
                finalMutation.messages = mutation.messages;
            }
            if (mutation.state.has_value()) {
                finalMutation.state = mutation.state;
            }
            
            if (mutation.stopPropagation) {
                finalMutation.stopPropagation = true;
                break;
            }
        } catch (const std::exception& e) {
            Logger::errorf("notifySubscribers: subscriber error: ", e.what());
            throwSubscriberFailure("event notification", e);
        } catch (...) {
            Logger::errorf("notifySubscribers: subscriber threw unknown exception");
            throwUnknownSubscriberFailure("event notification");
        }
    }

    return finalMutation;
}

void EventHandler::notifyNewMessage(const Message& message) {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onNewMessage(message, params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyNewMessage: subscriber error: ", e.what());
            throwSubscriberFailure("onNewMessage", e);
        } catch (...) {
            Logger::errorf("notifyNewMessage: subscriber threw unknown exception");
            throwUnknownSubscriberFailure("onNewMessage");
        }
    }
}

void EventHandler::notifyNewToolCall(const ToolCall& toolCall) {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onNewToolCall(toolCall, params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyNewToolCall: subscriber error: ", e.what());
            throwSubscriberFailure("onNewToolCall", e);
        } catch (...) {
            Logger::errorf("notifyNewToolCall: subscriber threw unknown exception");
            throwUnknownSubscriberFailure("onNewToolCall");
        }
    }
}

void EventHandler::notifyMessagesChanged() {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onMessagesChanged(params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyMessagesChanged: subscriber error: ", e.what());
            throwSubscriberFailure("onMessagesChanged", e);
        } catch (...) {
            Logger::errorf("notifyMessagesChanged: subscriber threw unknown exception");
            throwUnknownSubscriberFailure("onMessagesChanged");
        }
    }
}

void EventHandler::notifyStateChanged() {
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onStateChanged(params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyStateChanged: subscriber error: ", e.what());
            throwSubscriberFailure("onStateChanged", e);
        } catch (...) {
            Logger::errorf("notifyStateChanged: subscriber threw unknown exception");
            throwUnknownSubscriberFailure("onStateChanged");
        }
    }
}

void EventHandler::notifyRunFailed(const AgentError& error) {
    // Best-effort notification: unlike notifySubscribers/notifyNewMessage (which rethrow
    // on the first subscriber failure), these terminal callbacks intentionally continue
    // notifying all remaining subscribers even when one throws.  Rethrowing here would
    // cut off downstream subscribers from receiving the failure signal, leaving them in
    // an inconsistent state — the opposite of what cleanup callbacks are supposed to do.
    // Exceptions are logged but NOT re-raised; the original AgentError is already
    // propagating up the call stack and must not be masked by a subscriber exception.
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onRunFailed(error, params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyRunFailed: subscriber threw — continuing to notify remaining subscribers: ",
                           e.what());
        } catch (...) {
            Logger::errorf("notifyRunFailed: subscriber threw unknown exception — continuing to notify remaining subscribers");
        }
    }
}

void EventHandler::notifyRunFinalized() {
    // Same best-effort policy as notifyRunFailed: all subscribers are notified
    // regardless of individual failures.  See comment above for rationale.
    AgentSubscriberParams params = createParams();
    for (auto& subscriber : m_subscribers) {
        try {
            subscriber->onRunFinalized(params);
        } catch (const std::exception& e) {
            Logger::errorf("notifyRunFinalized: subscriber threw — continuing to notify remaining subscribers: ",
                           e.what());
        } catch (...) {
            Logger::errorf("notifyRunFinalized: subscriber threw unknown exception — continuing to notify remaining subscribers");
        }
    }
}

Message* EventHandler::findMessage(const MessageId& id) {
    auto it = m_messageIndex.find(id);
    if (it == m_messageIndex.end() || it->second >= m_messages.size()) {
        return nullptr;
    }
    return &m_messages[it->second];
}

Message* EventHandler::findMessageContainingToolCall(const ToolCallId& toolCallId) {
    auto it = m_toolCallToMessageIndex.find(toolCallId);
    if (it == m_toolCallToMessageIndex.end() || it->second >= m_messages.size()) {
        return nullptr;
    }
    return &m_messages[it->second];
}

void EventHandler::rebuildMessageIndex() {
    m_messageIndex.clear();
    m_toolCallToMessageIndex.clear();
    for (size_t i = 0; i < m_messages.size(); ++i) {
        m_messageIndex[m_messages[i].id()] = i;
        for (const auto& toolCall : m_messages[i].toolCalls()) {
            m_toolCallToMessageIndex[toolCall.id] = i;
        }
    }
}

void EventHandler::appendEventDelta(const ToolCallId& toolCallId, const std::string &delta) {
    Message* msg = findMessageContainingToolCall(toolCallId);
    if (!msg) {
        Logger::warningf("appendEventDelta: no message found for toolCallId=", toolCallId);
        return;
    }
    msg->appendEventDelta(toolCallId, delta);
}

AgentSubscriberParams EventHandler::createParams() const {
    return AgentSubscriberParams(&m_messages, &m_state);
}

void EventHandler::handleToolCallResult(const ToolCallResultEvent& event) {
    Message toolMessage = event.messageId.empty()
        ? Message::create(MessageRole::Tool, event.content, "", event.toolCallId)
        : Message::createWithId(event.messageId, MessageRole::Tool, event.content, "", event.toolCallId);
    m_messages.push_back(toolMessage);
    m_messageIndex[toolMessage.id()] = m_messages.size() - 1;
    notifyNewMessage(toolMessage);
    notifyMessagesChanged();
}

void EventHandler::handleActivitySnapshot(const ActivitySnapshotEvent& event) {
    Message* existing = findMessage(event.messageId);

    if (!existing) {
        Message activityMsg = Message::createWithId(event.messageId, MessageRole::Activity,
                                                    event.content.dump());
        activityMsg.setActivityType(event.activityType);
        m_messages.push_back(activityMsg);
        m_messageIndex[event.messageId] = m_messages.size() - 1;
        notifyNewMessage(m_messages.back());
    } else if (event.replace) {
        existing->setContent(event.content.dump());
        existing->setActivityType(event.activityType);
    }

    notifyMessagesChanged();
}

void EventHandler::handleActivityDelta(const ActivityDeltaEvent& event) {
    Message* existing = findMessage(event.messageId);
    if (!existing) {
        throw AGUI_ERROR(state, ErrorCode::StatePatchFailed,
                         "ActivityDeltaEvent: unknown activity messageId '" + event.messageId + "'");
    }

    if (existing->role() != MessageRole::Activity) {
        throw AGUI_ERROR(state, ErrorCode::StatePatchFailed,
                         "ActivityDeltaEvent: message '" + event.messageId + "' is not an activity message");
    }

    try {
        // Default to empty object if content is absent, consistent with TypeScript (content ?? {})
        nlohmann::json currentContent = existing->content().empty()
            ? nlohmann::json::object()
            : nlohmann::json::parse(existing->content());

        nlohmann::json patchJson = nlohmann::json::array();
        for (const auto& op : event.patch) {
            patchJson.push_back(op.toJson());
        }

        StateManager stateManager(currentContent);
        stateManager.applyPatch(patchJson);
        existing->setContent(stateManager.currentState().dump());
        existing->setActivityType(event.activityType);  // sync activityType from delta event
    } catch (const AgentError& e) {
        throw AGUI_ERROR(state, ErrorCode::StatePatchFailed,
                         "ActivityDeltaEvent: failed to update message '" + event.messageId + "': " + e.what());
    } catch (const std::exception& e) {
        Logger::errorf("handleActivityDelta: failed to apply patch for '", event.messageId, "': ", e.what());
        throw AGUI_ERROR(state, ErrorCode::StatePatchFailed,
                         "ActivityDeltaEvent: failed to update message '" + event.messageId + "': " + e.what());
    }

    notifyMessagesChanged();
}

}  // namespace agui
