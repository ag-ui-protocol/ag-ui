#include "event.h"

#include <ctime>
#include <iomanip>
#include <sstream>

namespace agui {

// BaseEventData Implementation

BaseEventData::BaseEventData() : timestamp(std::chrono::system_clock::now()) {}

nlohmann::json BaseEventData::toJson() const {
    nlohmann::json j;

    // Convert timestamp to ISO 8601 format
    auto time_t = std::chrono::system_clock::to_time_t(timestamp);
    std::tm tm = *std::gmtime(&time_t);
    std::ostringstream oss;
    oss << std::put_time(&tm, "%Y-%m-%dT%H:%M:%SZ");
    j["timestamp"] = oss.str();

    // Add raw event data if present
#if __cplusplus >= 201703L
    if (rawEvent.has_value()) {
        j["raw_event"] = rawEvent.value();
    }
#else
    if (rawEvent) {
        j["raw_event"] = *rawEvent;
    }
#endif

    return j;
}

BaseEventData BaseEventData::fromJson(const nlohmann::json& j) {
    BaseEventData data;

    // Parse timestamp if present
    if (j.contains("timestamp")) {
        data.timestamp = std::chrono::system_clock::now();
    }

    // Parse raw event data if present
    if (j.contains("raw_event")) {
#if __cplusplus >= 201703L
        data.rawEvent = j["raw_event"];
#else
        data.rawEvent.reset(new nlohmann::json(j["raw_event"]));
#endif
    }

    return data;
}

// Event Base Class Implementation

void Event::setRawEvent(const nlohmann::json& raw) {
#if __cplusplus >= 201703L
    m_baseData.rawEvent = raw;
#else
    m_baseData.rawEvent.reset(new nlohmann::json(raw));
#endif
}

// TextMessageStartEvent Implementation

nlohmann::json TextMessageStartEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_START";
    j["message_id"] = messageId;
    j["role"] = role;
    return j;
}

TextMessageStartEvent TextMessageStartEvent::fromJson(const nlohmann::json& j) {
    TextMessageStartEvent e;
    e.messageId = j.value("message_id", "");
    e.role = j.value("role", "");
    return e;
}

// TextMessageContentEvent Implementation

nlohmann::json TextMessageContentEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_CONTENT";
    j["delta"] = delta;
    return j;
}

TextMessageContentEvent TextMessageContentEvent::fromJson(const nlohmann::json& j) {
    TextMessageContentEvent e;
    e.delta = j.value("delta", "");
    return e;
}

// TextMessageEndEvent Implementation

nlohmann::json TextMessageEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_END";
    j["message_id"] = messageId;
    return j;
}

TextMessageEndEvent TextMessageEndEvent::fromJson(const nlohmann::json& j) {
    TextMessageEndEvent e;
    e.messageId = j.value("message_id", "");
    return e;
}

// TextMessageChunkEvent Implementation

nlohmann::json TextMessageChunkEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_CHUNK";
    j["message_id"] = messageId;
    j["content"] = content;
    return j;
}

TextMessageChunkEvent TextMessageChunkEvent::fromJson(const nlohmann::json& j) {
    TextMessageChunkEvent e;
    e.messageId = j.value("message_id", "");
    e.content = j.value("content", "");
    return e;
}

// ThinkingTextMessageStartEvent Implementation

nlohmann::json ThinkingTextMessageStartEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "THINKING_TEXT_MESSAGE_START";
    return j;
}

ThinkingTextMessageStartEvent ThinkingTextMessageStartEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageStartEvent e;
    (void)j;
    return e;
}

// ThinkingTextMessageContentEvent Implementation

nlohmann::json ThinkingTextMessageContentEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "THINKING_TEXT_MESSAGE_CONTENT";
    j["delta"] = delta;
    return j;
}

ThinkingTextMessageContentEvent ThinkingTextMessageContentEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageContentEvent e;
    e.delta = j.value("delta", "");
    return e;
}

// ThinkingTextMessageEndEvent Implementation

nlohmann::json ThinkingTextMessageEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "THINKING_TEXT_MESSAGE_END";
    return j;
}

ThinkingTextMessageEndEvent ThinkingTextMessageEndEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageEndEvent e;
    (void)j;
    return e;
}

// ToolCallStartEvent Implementation

nlohmann::json ToolCallStartEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_START";
    j["tool_call_id"] = toolCallId;
    j["tool_call_name"] = toolCallName;
    j["parent_message_id"] = parentMessageId;
    return j;
}

ToolCallStartEvent ToolCallStartEvent::fromJson(const nlohmann::json& j) {
    ToolCallStartEvent e;
    e.toolCallId = j.value("tool_call_id", "");
    e.toolCallName = j.value("tool_call_name", "");
    e.parentMessageId = j.value("parent_message_id", "");
    return e;
}

// ToolCallArgsEvent Implementation

nlohmann::json ToolCallArgsEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_ARGS";
    j["delta"] = delta;
    return j;
}

ToolCallArgsEvent ToolCallArgsEvent::fromJson(const nlohmann::json& j) {
    ToolCallArgsEvent e;
    e.delta = j.value("delta", "");
    return e;
}

// ToolCallEndEvent Implementation

nlohmann::json ToolCallEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_END";
    j["tool_call_id"] = toolCallId;
    return j;
}

ToolCallEndEvent ToolCallEndEvent::fromJson(const nlohmann::json& j) {
    ToolCallEndEvent e;
    e.toolCallId = j.value("tool_call_id", "");
    return e;
}

// ToolCallChunkEvent Implementation

nlohmann::json ToolCallChunkEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_CHUNK";
    j["tool_call_id"] = toolCallId;
    j["tool_call_name"] = toolCallName;
    j["arguments"] = arguments;
    return j;
}

ToolCallChunkEvent ToolCallChunkEvent::fromJson(const nlohmann::json& j) {
    ToolCallChunkEvent e;
    e.toolCallId = j.value("tool_call_id", "");
    e.toolCallName = j.value("tool_call_name", "");
    e.arguments = j.value("arguments", "");
    return e;
}

// ToolCallResultEvent Implementation

nlohmann::json ToolCallResultEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_RESULT";
    j["tool_call_id"] = toolCallId;
    j["result"] = result;
    return j;
}

ToolCallResultEvent ToolCallResultEvent::fromJson(const nlohmann::json& j) {
    ToolCallResultEvent e;
    e.toolCallId = j.value("tool_call_id", "");
    e.result = j.value("result", "");
    return e;
}

// ThinkingStartEvent Implementation

nlohmann::json ThinkingStartEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "THINKING_START";
    return j;
}

ThinkingStartEvent ThinkingStartEvent::fromJson(const nlohmann::json& j) {
    ThinkingStartEvent e;
    return e;
}

// ThinkingEndEvent Implementation

nlohmann::json ThinkingEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "THINKING_END";
    return j;
}

ThinkingEndEvent ThinkingEndEvent::fromJson(const nlohmann::json& j) {
    ThinkingEndEvent e;
    return e;
}

// StateSnapshotEvent Implementation

nlohmann::json StateSnapshotEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "STATE_SNAPSHOT";
    j["snapshot"] = snapshot;
    return j;
}

StateSnapshotEvent StateSnapshotEvent::fromJson(const nlohmann::json& j) {
    StateSnapshotEvent e;
    e.snapshot = j.value("snapshot", nlohmann::json::object());
    return e;
}

// StateDeltaEvent Implementation

nlohmann::json StateDeltaEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "STATE_DELTA";
    j["delta"] = delta;
    return j;
}

StateDeltaEvent StateDeltaEvent::fromJson(const nlohmann::json& j) {
    StateDeltaEvent e;
    e.delta = j.value("delta", nlohmann::json::array());
    return e;
}

// MessagesSnapshotEvent Implementation

nlohmann::json MessagesSnapshotEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "MESSAGES_SNAPSHOT";
    nlohmann::json messagesJson = nlohmann::json::array();
    for (const auto& msg : messages) {
        messagesJson.push_back(msg.toJson());
    }
    j["messages"] = messagesJson;
    return j;
}

MessagesSnapshotEvent MessagesSnapshotEvent::fromJson(const nlohmann::json& j) {
    MessagesSnapshotEvent e;
    if (j.contains("messages") && j["messages"].is_array()) {
        for (const auto& msgJson : j["messages"]) {
            e.messages.push_back(Message::fromJson(msgJson));
        }
    }
    return e;
}

// RunStartedEvent Implementation

nlohmann::json RunStartedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RUN_STARTED";
    j["run_id"] = runId;
    return j;
}

RunStartedEvent RunStartedEvent::fromJson(const nlohmann::json& j) {
    RunStartedEvent e;
    e.runId = j.value("run_id", "");
    return e;
}

// RunFinishedEvent Implementation

nlohmann::json RunFinishedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RUN_FINISHED";
    j["run_id"] = runId;
    j["result"] = result;
    return j;
}

RunFinishedEvent RunFinishedEvent::fromJson(const nlohmann::json& j) {
    RunFinishedEvent e;
    e.runId = j.value("run_id", "");
    e.result = j.value("result", nlohmann::json());
    return e;
}

// RunErrorEvent Implementation

nlohmann::json RunErrorEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RUN_ERROR";
    j["error"] = error;
    return j;
}

RunErrorEvent RunErrorEvent::fromJson(const nlohmann::json& j) {
    RunErrorEvent e;
    e.error = j.value("error", "");
    return e;
}

// StepStartedEvent Implementation

nlohmann::json StepStartedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "STEP_STARTED";
    j["step_id"] = stepId;
    return j;
}

StepStartedEvent StepStartedEvent::fromJson(const nlohmann::json& j) {
    StepStartedEvent e;
    e.stepId = j.value("step_id", "");
    return e;
}

// StepFinishedEvent Implementation

nlohmann::json StepFinishedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "STEP_FINISHED";
    j["step_id"] = stepId;
    return j;
}

StepFinishedEvent StepFinishedEvent::fromJson(const nlohmann::json& j) {
    StepFinishedEvent e;
    e.stepId = j.value("step_id", "");
    return e;
}

// RawEvent Implementation

nlohmann::json RawEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RAW";
    j["data"] = data;
    return j;
}

RawEvent RawEvent::fromJson(const nlohmann::json& j) {
    RawEvent e;
    e.data = j.value("data", "");
    return e;
}

// CustomEvent Implementation

nlohmann::json CustomEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "CUSTOM";
    j["event_type"] = eventType;
    j["data"] = data;
    return j;
}

CustomEvent CustomEvent::fromJson(const nlohmann::json& j) {
    CustomEvent e;
    e.eventType = j.value("event_type", "");
    e.data = j.value("data", nlohmann::json::object());
    return e;
}

// EventParser Implementation

EventType EventParser::parseEventType(const std::string& typeStr) {
    if (typeStr == "TEXT_MESSAGE_START")
        return EventType::TextMessageStart;
    if (typeStr == "TEXT_MESSAGE_CONTENT")
        return EventType::TextMessageContent;
    if (typeStr == "TEXT_MESSAGE_END")
        return EventType::TextMessageEnd;
    if (typeStr == "TEXT_MESSAGE_CHUNK")
        return EventType::TextMessageChunk;

    if (typeStr == "THINKING_TEXT_MESSAGE_START")
        return EventType::ThinkingTextMessageStart;
    if (typeStr == "THINKING_TEXT_MESSAGE_CONTENT")
        return EventType::ThinkingTextMessageContent;
    if (typeStr == "THINKING_TEXT_MESSAGE_END")
        return EventType::ThinkingTextMessageEnd;

    if (typeStr == "TOOL_CALL_START")
        return EventType::ToolCallStart;
    if (typeStr == "TOOL_CALL_ARGS")
        return EventType::ToolCallArgs;
    if (typeStr == "TOOL_CALL_END")
        return EventType::ToolCallEnd;
    if (typeStr == "TOOL_CALL_CHUNK")
        return EventType::ToolCallChunk;
    if (typeStr == "TOOL_CALL_RESULT")
        return EventType::ToolCallResult;

    if (typeStr == "THINKING_START")
        return EventType::ThinkingStart;
    if (typeStr == "THINKING_END")
        return EventType::ThinkingEnd;

    if (typeStr == "STATE_SNAPSHOT")
        return EventType::StateSnapshot;
    if (typeStr == "STATE_DELTA")
        return EventType::StateDelta;
    if (typeStr == "MESSAGES_SNAPSHOT")
        return EventType::MessagesSnapshot;

    if (typeStr == "RUN_STARTED")
        return EventType::RunStarted;
    if (typeStr == "RUN_FINISHED")
        return EventType::RunFinished;
    if (typeStr == "RUN_ERROR")
        return EventType::RunError;

    if (typeStr == "STEP_STARTED")
        return EventType::StepStarted;
    if (typeStr == "STEP_FINISHED")
        return EventType::StepFinished;

    if (typeStr == "RAW")
        return EventType::Raw;
    if (typeStr == "CUSTOM")
        return EventType::Custom;

    return EventType::Raw;
}

std::unique_ptr<Event> EventParser::parse(const nlohmann::json& j) {
    if (!j.contains("type")) {
        throw AGUI_ERROR(parse, ErrorCode::ParseEventError, "Event JSON missing 'type' field");
    }

    std::string typeStr = j["type"];
    EventType type = parseEventType(typeStr);

    switch (type) {
        case EventType::TextMessageStart:
            return std::unique_ptr<Event>(new TextMessageStartEvent(TextMessageStartEvent::fromJson(j)));

        case EventType::TextMessageContent:
            return std::unique_ptr<Event>(new TextMessageContentEvent(TextMessageContentEvent::fromJson(j)));

        case EventType::TextMessageEnd:
            return std::unique_ptr<Event>(new TextMessageEndEvent(TextMessageEndEvent::fromJson(j)));

        case EventType::TextMessageChunk:
            return std::unique_ptr<Event>(new TextMessageChunkEvent(TextMessageChunkEvent::fromJson(j)));

        case EventType::ThinkingTextMessageStart:
            return std::unique_ptr<Event>(
                new ThinkingTextMessageStartEvent(ThinkingTextMessageStartEvent::fromJson(j)));

        case EventType::ThinkingTextMessageContent:
            return std::unique_ptr<Event>(
                new ThinkingTextMessageContentEvent(ThinkingTextMessageContentEvent::fromJson(j)));

        case EventType::ThinkingTextMessageEnd:
            return std::unique_ptr<Event>(
                new ThinkingTextMessageEndEvent(ThinkingTextMessageEndEvent::fromJson(j)));

        case EventType::ToolCallStart:
            return std::unique_ptr<Event>(new ToolCallStartEvent(ToolCallStartEvent::fromJson(j)));

        case EventType::ToolCallArgs:
            return std::unique_ptr<Event>(new ToolCallArgsEvent(ToolCallArgsEvent::fromJson(j)));

        case EventType::ToolCallEnd:
            return std::unique_ptr<Event>(new ToolCallEndEvent(ToolCallEndEvent::fromJson(j)));

        case EventType::ToolCallChunk:
            return std::unique_ptr<Event>(new ToolCallChunkEvent(ToolCallChunkEvent::fromJson(j)));

        case EventType::ToolCallResult:
            return std::unique_ptr<Event>(new ToolCallResultEvent(ToolCallResultEvent::fromJson(j)));

        case EventType::ThinkingStart:
            return std::unique_ptr<Event>(new ThinkingStartEvent(ThinkingStartEvent::fromJson(j)));

        case EventType::ThinkingEnd:
            return std::unique_ptr<Event>(new ThinkingEndEvent(ThinkingEndEvent::fromJson(j)));

        case EventType::StateSnapshot:
            return std::unique_ptr<Event>(new StateSnapshotEvent(StateSnapshotEvent::fromJson(j)));

        case EventType::StateDelta:
            return std::unique_ptr<Event>(new StateDeltaEvent(StateDeltaEvent::fromJson(j)));

        case EventType::MessagesSnapshot:
            return std::unique_ptr<Event>(new MessagesSnapshotEvent(MessagesSnapshotEvent::fromJson(j)));

        case EventType::RunStarted:
            return std::unique_ptr<Event>(new RunStartedEvent(RunStartedEvent::fromJson(j)));

        case EventType::RunFinished:
            return std::unique_ptr<Event>(new RunFinishedEvent(RunFinishedEvent::fromJson(j)));

        case EventType::RunError:
            return std::unique_ptr<Event>(new RunErrorEvent(RunErrorEvent::fromJson(j)));

        case EventType::StepStarted:
            return std::unique_ptr<Event>(new StepStartedEvent(StepStartedEvent::fromJson(j)));

        case EventType::StepFinished:
            return std::unique_ptr<Event>(new StepFinishedEvent(StepFinishedEvent::fromJson(j)));

        case EventType::Raw:
            return std::unique_ptr<Event>(new RawEvent(RawEvent::fromJson(j)));

        case EventType::Custom:
            return std::unique_ptr<Event>(new CustomEvent(CustomEvent::fromJson(j)));

        default:
            auto rawEvent = std::unique_ptr<RawEvent>(new RawEvent());
            rawEvent->data = j.dump();
            return std::move(rawEvent);
    }
}

std::string EventParser::eventTypeToString(EventType type) {
    switch (type) {
        case EventType::TextMessageStart:
            return "TEXT_MESSAGE_START";
        case EventType::TextMessageContent:
            return "TEXT_MESSAGE_CONTENT";
        case EventType::TextMessageEnd:
            return "TEXT_MESSAGE_END";
        case EventType::TextMessageChunk:
            return "TEXT_MESSAGE_CHUNK";

        case EventType::ThinkingTextMessageStart:
            return "THINKING_TEXT_MESSAGE_START";
        case EventType::ThinkingTextMessageContent:
            return "THINKING_TEXT_MESSAGE_CONTENT";
        case EventType::ThinkingTextMessageEnd:
            return "THINKING_TEXT_MESSAGE_END";

        case EventType::ToolCallStart:
            return "TOOL_CALL_START";
        case EventType::ToolCallArgs:
            return "TOOL_CALL_ARGS";
        case EventType::ToolCallEnd:
            return "TOOL_CALL_END";
        case EventType::ToolCallChunk:
            return "TOOL_CALL_CHUNK";
        case EventType::ToolCallResult:
            return "TOOL_CALL_RESULT";

        case EventType::ThinkingStart:
            return "THINKING_START";
        case EventType::ThinkingEnd:
            return "THINKING_END";

        case EventType::StateSnapshot:
            return "STATE_SNAPSHOT";
        case EventType::StateDelta:
            return "STATE_DELTA";
        case EventType::MessagesSnapshot:
            return "MESSAGES_SNAPSHOT";

        case EventType::RunStarted:
            return "RUN_STARTED";
        case EventType::RunFinished:
            return "RUN_FINISHED";
        case EventType::RunError:
            return "RUN_ERROR";

        case EventType::StepStarted:
            return "STEP_STARTED";
        case EventType::StepFinished:
            return "STEP_FINISHED";

        case EventType::Raw:
            return "RAW";
        case EventType::Custom:
            return "CUSTOM";

        default:
            return "unknown";
    }
}

}  // namespace agui
