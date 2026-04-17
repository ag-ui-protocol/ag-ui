#include "event.h"

#include "core/error.h"

namespace agui {

namespace {

void requireNonEmptyString(const std::string& value, const std::string& fieldName, const std::string& eventName) {
    if (value.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         eventName + ": " + fieldName + " is required");
    }
}

}  // namespace

// BaseEventData Implementation

nlohmann::json BaseEventData::toJson() const {
    nlohmann::json j;

    if (timestamp.has_value()) {
        j["timestamp"] = timestamp.value();
    }

    if (rawEvent.has_value()) {
        j["rawEvent"] = rawEvent.value();
    }

    return j;
}

BaseEventData BaseEventData::fromJson(const nlohmann::json& j) {
    BaseEventData data;

    if (j.contains("timestamp") && j["timestamp"].is_number()) {
        data.timestamp = j["timestamp"].get<int64_t>();
    }

    if (j.contains("rawEvent")) {
        data.rawEvent = j["rawEvent"];
    }

    return data;
}

// Event Base Class Implementation

void Event::setRawEvent(const nlohmann::json& raw) {
    m_baseData.rawEvent = raw;
}

nlohmann::json Event::baseFieldsToJson() const {
    return m_baseData.toJson();
}

// TextMessageStartEvent Implementation

nlohmann::json TextMessageStartEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TEXT_MESSAGE_START";
    j["messageId"] = messageId;
    if (role.has_value()) {
        j["role"] = Message::roleToString(role.value());
    }
    return j;
}

TextMessageStartEvent TextMessageStartEvent::fromJson(const nlohmann::json& j) {
    TextMessageStartEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.messageId = j.value("messageId", "");
    if (j.contains("role") && j["role"].is_string()) {
        e.role = Message::roleFromString(j["role"].get<std::string>());
    }
    return e;
}

void TextMessageStartEvent::validate() const {
    requireNonEmptyString(messageId, "messageId", "TextMessageStartEvent");
    if (role.has_value() && role.value() == MessageRole::Tool) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         "TextMessageStartEvent: role 'tool' is not allowed");
    }
}

// TextMessageContentEvent Implementation

nlohmann::json TextMessageContentEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TEXT_MESSAGE_CONTENT";
    j["messageId"] = messageId;
    j["delta"] = delta;
    return j;
}

TextMessageContentEvent TextMessageContentEvent::fromJson(const nlohmann::json& j) {
    TextMessageContentEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.messageId = j.value("messageId", "");
    e.delta = j.value("delta", "");
    return e;
}

void TextMessageContentEvent::validate() const {
    requireNonEmptyString(messageId, "messageId", "TextMessageContentEvent");
    requireNonEmptyString(delta, "delta", "TextMessageContentEvent");
}

// TextMessageEndEvent Implementation

nlohmann::json TextMessageEndEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TEXT_MESSAGE_END";
    j["messageId"] = messageId;
    return j;
}

TextMessageEndEvent TextMessageEndEvent::fromJson(const nlohmann::json& j) {
    TextMessageEndEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.messageId = j.value("messageId", "");
    return e;
}

void TextMessageEndEvent::validate() const {
    requireNonEmptyString(messageId, "messageId", "TextMessageEndEvent");
}

// TextMessageChunkEvent Implementation

nlohmann::json TextMessageChunkEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TEXT_MESSAGE_CHUNK";
    j["messageId"] = messageId;
    j["delta"] = delta;
    if (role.has_value()) {
        j["role"] = Message::roleToString(role.value());
    }
    if (name.has_value()) {
        j["name"] = name.value();
    }
    return j;
}

TextMessageChunkEvent TextMessageChunkEvent::fromJson(const nlohmann::json& j) {
    TextMessageChunkEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.messageId = j.value("messageId", "");
    e.delta = j.value("delta", "");
    if (j.contains("role") && j["role"].is_string()) {
        e.role = Message::roleFromString(j["role"].get<std::string>());
    }
    if (j.contains("name") && j["name"].is_string()) {
        e.name = j["name"].get<std::string>();
    }
    return e;
}

// ThinkingTextMessageStartEvent Implementation

nlohmann::json ThinkingTextMessageStartEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "THINKING_TEXT_MESSAGE_START";
    return j;
}

ThinkingTextMessageStartEvent ThinkingTextMessageStartEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageStartEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    return e;
}

// ThinkingTextMessageContentEvent Implementation

nlohmann::json ThinkingTextMessageContentEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "THINKING_TEXT_MESSAGE_CONTENT";
    j["delta"] = delta;
    return j;
}

ThinkingTextMessageContentEvent ThinkingTextMessageContentEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageContentEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.delta = j.value("delta", "");
    return e;
}

// ThinkingTextMessageEndEvent Implementation

nlohmann::json ThinkingTextMessageEndEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "THINKING_TEXT_MESSAGE_END";
    return j;
}

ThinkingTextMessageEndEvent ThinkingTextMessageEndEvent::fromJson(const nlohmann::json& j) {
    ThinkingTextMessageEndEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    return e;
}

// ToolCallStartEvent Implementation

nlohmann::json ToolCallStartEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TOOL_CALL_START";
    j["toolCallId"] = toolCallId;
    j["toolCallName"] = toolCallName;
    if (parentMessageId.has_value()) {
        j["parentMessageId"] = parentMessageId.value();
    }
    return j;
}

ToolCallStartEvent ToolCallStartEvent::fromJson(const nlohmann::json& j) {
    ToolCallStartEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.toolCallId = j.value("toolCallId", "");
    e.toolCallName = j.value("toolCallName", "");
    if (j.contains("parentMessageId") && j["parentMessageId"].is_string()) {
        e.parentMessageId = j["parentMessageId"].get<std::string>();
    }
    return e;
}

void ToolCallStartEvent::validate() const {
    requireNonEmptyString(toolCallId, "toolCallId", "ToolCallStartEvent");
    requireNonEmptyString(toolCallName, "toolCallName", "ToolCallStartEvent");
}

// ToolCallArgsEvent Implementation

nlohmann::json ToolCallArgsEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TOOL_CALL_ARGS";
    j["toolCallId"] = toolCallId;
    j["delta"] = delta;
    return j;
}

ToolCallArgsEvent ToolCallArgsEvent::fromJson(const nlohmann::json& j) {
    ToolCallArgsEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.toolCallId = j.value("toolCallId", "");
    e.delta = j.value("delta", "");
    return e;
}

void ToolCallArgsEvent::validate() const {
    requireNonEmptyString(toolCallId, "toolCallId", "ToolCallArgsEvent");
}

// ToolCallEndEvent Implementation

nlohmann::json ToolCallEndEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TOOL_CALL_END";
    j["toolCallId"] = toolCallId;
    return j;
}

ToolCallEndEvent ToolCallEndEvent::fromJson(const nlohmann::json& j) {
    ToolCallEndEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.toolCallId = j.value("toolCallId", "");
    return e;
}

void ToolCallEndEvent::validate() const {
    requireNonEmptyString(toolCallId, "toolCallId", "ToolCallEndEvent");
}

// ToolCallChunkEvent Implementation

nlohmann::json ToolCallChunkEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TOOL_CALL_CHUNK";
    j["toolCallId"] = toolCallId;
    if (toolCallName.has_value()) {
        j["toolCallName"] = toolCallName.value();
    }
    j["delta"] = delta;
    if (parentMessageId.has_value()) {
        j["parentMessageId"] = parentMessageId.value();
    }
    return j;
}

ToolCallChunkEvent ToolCallChunkEvent::fromJson(const nlohmann::json& j) {
    ToolCallChunkEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.toolCallId = j.value("toolCallId", "");
    if (j.contains("toolCallName") && j["toolCallName"].is_string()) {
        e.toolCallName = j["toolCallName"].get<std::string>();
    }
    e.delta = j.value("delta", "");
    if (j.contains("parentMessageId") && j["parentMessageId"].is_string()) {
        e.parentMessageId = j["parentMessageId"].get<std::string>();
    }
    return e;
}

// ToolCallResultEvent Implementation

nlohmann::json ToolCallResultEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "TOOL_CALL_RESULT";
    j["messageId"] = messageId;
    j["toolCallId"] = toolCallId;
    j["content"] = content;
    if (role.has_value()) {
        j["role"] = Message::roleToString(role.value());
    }
    return j;
}

ToolCallResultEvent ToolCallResultEvent::fromJson(const nlohmann::json& j) {
    ToolCallResultEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.messageId = j.value("messageId", "");
    e.toolCallId = j.value("toolCallId", "");
    e.content = j.value("content", "");
    if (j.contains("role") && j["role"].is_string()) {
        e.role = Message::roleFromString(j["role"].get<std::string>());
    }
    return e;
}

void ToolCallResultEvent::validate() const {
    requireNonEmptyString(toolCallId, "toolCallId", "ToolCallResultEvent");
    // content can be empty string but should not be omitted from the event
    // (empty content is valid for tool calls that return no data)
    if (role.has_value() && role.value() != MessageRole::Tool) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         "ToolCallResultEvent: role must be 'tool' when provided");
    }
}

// ThinkingStartEvent Implementation

nlohmann::json ThinkingStartEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "THINKING_START";
    return j;
}

ThinkingStartEvent ThinkingStartEvent::fromJson(const nlohmann::json& j) {
    ThinkingStartEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    return e;
}

// ThinkingEndEvent Implementation

nlohmann::json ThinkingEndEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "THINKING_END";
    return j;
}

ThinkingEndEvent ThinkingEndEvent::fromJson(const nlohmann::json& j) {
    ThinkingEndEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    return e;
}

// StateSnapshotEvent Implementation

nlohmann::json StateSnapshotEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "STATE_SNAPSHOT";
    j["snapshot"] = snapshot;
    return j;
}

StateSnapshotEvent StateSnapshotEvent::fromJson(const nlohmann::json& j) {
    StateSnapshotEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.snapshot = j.value("snapshot", nlohmann::json::object());
    return e;
}

void StateSnapshotEvent::validate() const {
    if (snapshot.is_null()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         "StateSnapshotEvent: snapshot is required");
    }
}

// StateDeltaEvent Implementation

nlohmann::json StateDeltaEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "STATE_DELTA";
    j["delta"] = delta;
    return j;
}

StateDeltaEvent StateDeltaEvent::fromJson(const nlohmann::json& j) {
    StateDeltaEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.delta = j.value("delta", nlohmann::json::array());
    return e;
}

void StateDeltaEvent::validate() const {
    if (!delta.is_array()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         "StateDeltaEvent: delta must be an array");
    }
    for (const auto& opJson : delta) {
        JsonPatchOp::fromJson(opJson).validate();
    }
}

// MessagesSnapshotEvent Implementation

nlohmann::json MessagesSnapshotEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
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
    e.m_baseData = BaseEventData::fromJson(j);
    if (j.contains("messages") && j["messages"].is_array()) {
        for (const auto& msgJson : j["messages"]) {
            e.messages.push_back(Message::fromJson(msgJson));
        }
    }
    return e;
}

void MessagesSnapshotEvent::validate() const {
    for (const auto& message : messages) {
        requireNonEmptyString(message.id(), "message.id", "MessagesSnapshotEvent");
    }
}

// ActivitySnapshotEvent Implementation

nlohmann::json ActivitySnapshotEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "ACTIVITY_SNAPSHOT";
    j["messageId"] = messageId;
    j["activityType"] = activityType;
    j["content"] = content;
    j["replace"] = replace;
    return j;
}

void ActivitySnapshotEvent::validate() const {
    if (messageId.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivitySnapshotEvent: messageId is required");
    }
    if (activityType.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivitySnapshotEvent: activityType is required");
    }
    if (content.is_null()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivitySnapshotEvent: content is required");
    }
}

ActivitySnapshotEvent ActivitySnapshotEvent::fromJson(const nlohmann::json& j) {
    ActivitySnapshotEvent event;
    event.m_baseData = BaseEventData::fromJson(j);
    event.messageId = j.value("messageId", "");
    event.activityType = j.value("activityType", "");
    event.content = j.value("content", nlohmann::json());

    if (j.contains("replace")) {
        event.replace = j.value("replace", false);
    }

    return event;
}

// ActivityDeltaEvent Implementation

nlohmann::json ActivityDeltaEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "ACTIVITY_DELTA";
    j["messageId"] = messageId;
    j["activityType"] = activityType;
    
    nlohmann::json patchArray = nlohmann::json::array();
    for (const auto& op : patch) {
        patchArray.push_back(op.toJson());
    }
    j["patch"] = patchArray;
    
    return j;
}

void ActivityDeltaEvent::validate() const {
    if (messageId.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivityDeltaEvent: messageId is required");
    }
    if (activityType.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivityDeltaEvent: activityType is required");
    }
    if (patch.empty()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "ActivityDeltaEvent: patch must not be empty");
    }

    // Validate each patch operation
    for (size_t i = 0; i < patch.size(); ++i) {
        try {
            patch[i].validate();
        } catch (const AgentError& e) {
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                           "ActivityDeltaEvent: invalid patch operation at index " + 
                           std::to_string(i) + ": " + e.what());
        }
    }
}

ActivityDeltaEvent ActivityDeltaEvent::fromJson(const nlohmann::json& j) {
    ActivityDeltaEvent event;
    event.m_baseData = BaseEventData::fromJson(j);
    event.messageId = j.value("messageId", "");
    event.activityType = j.value("activityType", "");

    // Safely get patch array, default to empty array if missing
    const auto& patchArray = j.value("patch", nlohmann::json::array());
    if (patchArray.is_array()) {
        for (const auto& patchJson : patchArray) {
            event.patch.push_back(JsonPatchOp::fromJson(patchJson));
        }
    }

    return event;
}

// RunStartedEvent Implementation

nlohmann::json RunStartedEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "RUN_STARTED";
    j["threadId"] = threadId;
    j["runId"] = runId;
    return j;
}

RunStartedEvent RunStartedEvent::fromJson(const nlohmann::json& j) {
    RunStartedEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.threadId = j.value("threadId", "");
    e.runId = j.value("runId", "");
    return e;
}

void RunStartedEvent::validate() const {
    requireNonEmptyString(threadId, "threadId", "RunStartedEvent");
    requireNonEmptyString(runId, "runId", "RunStartedEvent");
}

// RunFinishedEvent Implementation

nlohmann::json RunFinishedEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "RUN_FINISHED";
    j["threadId"] = threadId;
    j["runId"] = runId;
    if (!result.is_null()) {
        j["result"] = result;
    }
    return j;
}

RunFinishedEvent RunFinishedEvent::fromJson(const nlohmann::json& j) {
    RunFinishedEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.threadId = j.value("threadId", "");
    e.runId = j.value("runId", "");
    e.result = j.value("result", nlohmann::json());
    return e;
}

void RunFinishedEvent::validate() const {
    requireNonEmptyString(threadId, "threadId", "RunFinishedEvent");
    requireNonEmptyString(runId, "runId", "RunFinishedEvent");
}

// RunErrorEvent Implementation

nlohmann::json RunErrorEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "RUN_ERROR";
    j["message"] = message;
    if (code.has_value()) {
        j["code"] = code.value();
    }
    return j;
}

RunErrorEvent RunErrorEvent::fromJson(const nlohmann::json& j) {
    RunErrorEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.message = j.value("message", "");
    if (j.contains("code") && j["code"].is_string()) {
        e.code = j["code"].get<std::string>();
    }
    return e;
}

void RunErrorEvent::validate() const {
    requireNonEmptyString(message, "message", "RunErrorEvent");
}

// StepStartedEvent Implementation

nlohmann::json StepStartedEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "STEP_STARTED";
    j["stepName"] = stepName;
    return j;
}

StepStartedEvent StepStartedEvent::fromJson(const nlohmann::json& j) {
    StepStartedEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.stepName = j.value("stepName", "");
    return e;
}

void StepStartedEvent::validate() const {
    requireNonEmptyString(stepName, "stepName", "StepStartedEvent");
}

// StepFinishedEvent Implementation

nlohmann::json StepFinishedEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "STEP_FINISHED";
    j["stepName"] = stepName;
    return j;
}

StepFinishedEvent StepFinishedEvent::fromJson(const nlohmann::json& j) {
    StepFinishedEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.stepName = j.value("stepName", "");
    return e;
}

void StepFinishedEvent::validate() const {
    requireNonEmptyString(stepName, "stepName", "StepFinishedEvent");
}

// RawEvent Implementation

nlohmann::json RawEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "RAW";
    j["event"] = event;
    if (source.has_value()) {
        j["source"] = source.value();
    }
    return j;
}

RawEvent RawEvent::fromJson(const nlohmann::json& j) {
    RawEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    if (j.contains("event")) {
        e.event = j["event"];
    }
    if (j.contains("source") && j["source"].is_string()) {
        e.source = j["source"].get<std::string>();
    }
    return e;
}

// CustomEvent Implementation

nlohmann::json CustomEvent::toJson() const {
    nlohmann::json j = baseFieldsToJson();
    j["type"] = "CUSTOM";
    j["name"] = name;
    j["value"] = value;
    return j;
}

CustomEvent CustomEvent::fromJson(const nlohmann::json& j) {
    CustomEvent e;
    e.m_baseData = BaseEventData::fromJson(j);
    e.name = j.value("name", "");
    e.value = j.value("value", nlohmann::json());
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

    if (typeStr == "ACTIVITY_SNAPSHOT")
        return EventType::ActivitySnapshot;
    if (typeStr == "ACTIVITY_DELTA")
        return EventType::ActivityDelta;

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

    throw AGUI_ERROR(parse, ErrorCode::ParseEventError, "Unknown event type: " + typeStr);
}

std::unique_ptr<Event> EventParser::parse(const nlohmann::json& j) {
    if (!j.contains("type")) {
        throw AGUI_ERROR(parse, ErrorCode::ParseEventError, "Event JSON missing 'type' field");
    }

    if (!j["type"].is_string()) {
        throw AGUI_ERROR(parse, ErrorCode::ParseEventError,
                         "Event 'type' field must be a string, got: " + j["type"].dump());
    }
    std::string typeStr = j["type"].get<std::string>();
    EventType type = parseEventType(typeStr);

    switch (type) {
        case EventType::TextMessageStart:
            return std::make_unique<TextMessageStartEvent>(TextMessageStartEvent::fromJson(j));

        case EventType::TextMessageContent:
            return std::make_unique<TextMessageContentEvent>(TextMessageContentEvent::fromJson(j));

        case EventType::TextMessageEnd:
            return std::make_unique<TextMessageEndEvent>(TextMessageEndEvent::fromJson(j));

        case EventType::TextMessageChunk:
            return std::make_unique<TextMessageChunkEvent>(TextMessageChunkEvent::fromJson(j));

        case EventType::ThinkingTextMessageStart:
            return std::make_unique<ThinkingTextMessageStartEvent>(ThinkingTextMessageStartEvent::fromJson(j));

        case EventType::ThinkingTextMessageContent:
            return std::make_unique<ThinkingTextMessageContentEvent>(ThinkingTextMessageContentEvent::fromJson(j));

        case EventType::ThinkingTextMessageEnd:
            return std::make_unique<ThinkingTextMessageEndEvent>(ThinkingTextMessageEndEvent::fromJson(j));

        case EventType::ToolCallStart:
            return std::make_unique<ToolCallStartEvent>(ToolCallStartEvent::fromJson(j));

        case EventType::ToolCallArgs:
            return std::make_unique<ToolCallArgsEvent>(ToolCallArgsEvent::fromJson(j));

        case EventType::ToolCallEnd:
            return std::make_unique<ToolCallEndEvent>(ToolCallEndEvent::fromJson(j));

        case EventType::ToolCallChunk:
            return std::make_unique<ToolCallChunkEvent>(ToolCallChunkEvent::fromJson(j));

        case EventType::ToolCallResult:
            return std::make_unique<ToolCallResultEvent>(ToolCallResultEvent::fromJson(j));

        case EventType::ThinkingStart:
            return std::make_unique<ThinkingStartEvent>(ThinkingStartEvent::fromJson(j));

        case EventType::ThinkingEnd:
            return std::make_unique<ThinkingEndEvent>(ThinkingEndEvent::fromJson(j));

        case EventType::StateSnapshot:
            return std::make_unique<StateSnapshotEvent>(StateSnapshotEvent::fromJson(j));

        case EventType::StateDelta:
            return std::make_unique<StateDeltaEvent>(StateDeltaEvent::fromJson(j));

        case EventType::MessagesSnapshot:
            return std::make_unique<MessagesSnapshotEvent>(MessagesSnapshotEvent::fromJson(j));

        case EventType::ActivitySnapshot:
            return std::make_unique<ActivitySnapshotEvent>(ActivitySnapshotEvent::fromJson(j));

        case EventType::ActivityDelta:
            return std::make_unique<ActivityDeltaEvent>(ActivityDeltaEvent::fromJson(j));

        case EventType::RunStarted:
            return std::make_unique<RunStartedEvent>(RunStartedEvent::fromJson(j));

        case EventType::RunFinished:
            return std::make_unique<RunFinishedEvent>(RunFinishedEvent::fromJson(j));

        case EventType::RunError:
            return std::make_unique<RunErrorEvent>(RunErrorEvent::fromJson(j));

        case EventType::StepStarted:
            return std::make_unique<StepStartedEvent>(StepStartedEvent::fromJson(j));

        case EventType::StepFinished:
            return std::make_unique<StepFinishedEvent>(StepFinishedEvent::fromJson(j));

        case EventType::Raw:
            return std::make_unique<RawEvent>(RawEvent::fromJson(j));

        case EventType::Custom:
            return std::make_unique<CustomEvent>(CustomEvent::fromJson(j));

        default:
            // Unreachable: parseEventType() throws AgentError for unknown types
            // before reaching this switch. Unknown types are handled in
            // parseSseEventData() which catches and skips them.
            throw AGUI_ERROR(parse, ErrorCode::ParseEventError,
                             "Unhandled event type in switch: " + typeStr);
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

        case EventType::ActivitySnapshot:
            return "ACTIVITY_SNAPSHOT";
        case EventType::ActivityDelta:
            return "ACTIVITY_DELTA";

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
