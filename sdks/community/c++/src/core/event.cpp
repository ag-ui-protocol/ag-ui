#include "event.h"

#include <set>
#include "core/error.h"

namespace agui {

// BaseEventData Implementation

BaseEventData::BaseEventData() : timestamp(std::chrono::system_clock::now()) {}

nlohmann::json BaseEventData::toJson() const {
    nlohmann::json j;

    j["timestamp"] = std::chrono::duration_cast<std::chrono::milliseconds>(
                         timestamp.time_since_epoch()).count();

    // Add raw event data if present
    if (rawEvent.has_value()) {
        j["rawEvent"] = rawEvent.value();
    }

    return j;
}

BaseEventData BaseEventData::fromJson(const nlohmann::json& j) {
    BaseEventData data;

    if (j.contains("timestamp") && j["timestamp"].is_number()) {
        data.timestamp = std::chrono::system_clock::time_point(
            std::chrono::milliseconds(j["timestamp"].get<int64_t>()));
    }

    // Parse raw event data if present
    if (j.contains("rawEvent")) {
        data.rawEvent = j["rawEvent"];
    }

    return data;
}

// Event Base Class Implementation

void Event::setRawEvent(const nlohmann::json& raw) {
    m_baseData.rawEvent = raw;
}

// TextMessageStartEvent Implementation

nlohmann::json TextMessageStartEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_START";
    j["messageId"] = messageId;
    j["role"] = role;
    return j;
}

TextMessageStartEvent TextMessageStartEvent::fromJson(const nlohmann::json& j) {
    TextMessageStartEvent e;
    e.messageId = j.value("messageId", "");
    e.role = j.value("role", "");
    return e;
}

// TextMessageContentEvent Implementation

nlohmann::json TextMessageContentEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_CONTENT";
    j["messageId"] = messageId;
    j["delta"] = delta;
    return j;
}

TextMessageContentEvent TextMessageContentEvent::fromJson(const nlohmann::json& j) {
    TextMessageContentEvent e;
    e.messageId = j.value("messageId", "");
    e.delta = j.value("delta", "");
    return e;
}

// TextMessageEndEvent Implementation

nlohmann::json TextMessageEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_END";
    j["messageId"] = messageId;
    return j;
}

TextMessageEndEvent TextMessageEndEvent::fromJson(const nlohmann::json& j) {
    TextMessageEndEvent e;
    e.messageId = j.value("messageId", "");
    return e;
}

// TextMessageChunkEvent Implementation

nlohmann::json TextMessageChunkEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TEXT_MESSAGE_CHUNK";
    j["messageId"] = messageId;
    j["content"] = content;
    return j;
}

TextMessageChunkEvent TextMessageChunkEvent::fromJson(const nlohmann::json& j) {
    TextMessageChunkEvent e;
    e.messageId = j.value("messageId", "");
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
    j["toolCallId"] = toolCallId;
    j["toolCallName"] = toolCallName;
    j["parentMessageId"] = parentMessageId;
    return j;
}

ToolCallStartEvent ToolCallStartEvent::fromJson(const nlohmann::json& j) {
    ToolCallStartEvent e;
    e.toolCallId = j.value("toolCallId", "");
    e.toolCallName = j.value("toolCallName", "");
    e.parentMessageId = j.value("parentMessageId", "");
    return e;
}

// ToolCallArgsEvent Implementation

nlohmann::json ToolCallArgsEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_ARGS";
    j["toolCallId"] = toolCallId;
    j["messageId"] = messageId;
    j["delta"] = delta;
    return j;
}

ToolCallArgsEvent ToolCallArgsEvent::fromJson(const nlohmann::json& j) {
    ToolCallArgsEvent e;
    e.toolCallId = j.value("toolCallId", "");
    e.messageId = j.value("messageId", "");
    e.delta = j.value("delta", "");
    return e;
}

// ToolCallEndEvent Implementation

nlohmann::json ToolCallEndEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_END";
    j["toolCallId"] = toolCallId;
    return j;
}

ToolCallEndEvent ToolCallEndEvent::fromJson(const nlohmann::json& j) {
    ToolCallEndEvent e;
    e.toolCallId = j.value("toolCallId", "");
    return e;
}

// ToolCallChunkEvent Implementation

nlohmann::json ToolCallChunkEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_CHUNK";
    j["toolCallId"] = toolCallId;
    j["toolCallName"] = toolCallName;
    j["arguments"] = arguments;
    return j;
}

ToolCallChunkEvent ToolCallChunkEvent::fromJson(const nlohmann::json& j) {
    ToolCallChunkEvent e;
    e.toolCallId = j.value("toolCallId", "");
    e.toolCallName = j.value("toolCallName", "");
    e.arguments = j.value("arguments", "");
    return e;
}

// ToolCallResultEvent Implementation

nlohmann::json ToolCallResultEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "TOOL_CALL_RESULT";
    j["toolCallId"] = toolCallId;
    j["result"] = result;
    return j;
}

ToolCallResultEvent ToolCallResultEvent::fromJson(const nlohmann::json& j) {
    ToolCallResultEvent e;
    e.toolCallId = j.value("toolCallId", "");
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

// JsonPatchOperation Implementation

nlohmann::json JsonPatchOperation::toJson() const {
    nlohmann::json j;
    j["op"] = op;
    j["path"] = path;
    
    if (!value.is_null()) {
        j["value"] = value;
    }
    
    if (!from.empty()) {
        j["from"] = from;
    }
    
    return j;
}

JsonPatchOperation JsonPatchOperation::fromJson(const nlohmann::json& j) {
    JsonPatchOperation operation;
    operation.op = j.at("op").get<std::string>();
    operation.path = j.at("path").get<std::string>();
    
    if (j.contains("value")) {
        operation.value = j["value"];
    }
    
    if (j.contains("from")) {
        operation.from = j["from"].get<std::string>();
    }
    
    return operation;
}

void JsonPatchOperation::validate() const {
    // Validate operation type
    static const std::set<std::string> validOps = {
        "add", "remove", "replace", "move", "copy", "test"
    };
    
    if (validOps.find(op) == validOps.end()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "Invalid JSON Patch operation: " + op);
    }
    
    // Validate path format (must start with /)
    if (path.empty() || path[0] != '/') {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "Invalid JSON Pointer path: " + path);
    }
    
    // move and copy operations require from field
    if ((op == "move" || op == "copy")) {
        if (from.empty()) {
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                            "Operation '" + op + "' requires 'from' field");
        }
        // Validate from field format (must also start with /)
        if (from[0] != '/') {
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                            "Invalid JSON Pointer 'from' path: " + from);
        }
    }
    
    // add, replace, test operations require value field
    if ((op == "add" || op == "replace" || op == "test") && value.is_null()) {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                        "Operation '" + op + "' requires 'value' field");
    }
}

// ActivitySnapshotEvent Implementation

nlohmann::json ActivitySnapshotEvent::toJson() const {
    nlohmann::json j = m_baseData.toJson();
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
    event.messageId = j.at("messageId").get<std::string>();
    event.activityType = j.at("activityType").get<std::string>();
    event.content = j.at("content");
    
    if (j.contains("replace")) {
        event.replace = j["replace"].get<bool>();
    }
    
    return event;
}

// ActivityDeltaEvent Implementation

nlohmann::json ActivityDeltaEvent::toJson() const {
    nlohmann::json j = m_baseData.toJson();
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
                        "ActivityDeltaEvent: patch must contain at least one operation");
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
    event.messageId = j.at("messageId").get<std::string>();
    event.activityType = j.at("activityType").get<std::string>();
    
    const auto& patchArray = j.at("patch");
    for (const auto& patchJson : patchArray) {
        event.patch.push_back(JsonPatchOperation::fromJson(patchJson));
    }
    
    return event;
}

// RunStartedEvent Implementation

nlohmann::json RunStartedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RUN_STARTED";
    j["runId"] = runId;
    return j;
}

RunStartedEvent RunStartedEvent::fromJson(const nlohmann::json& j) {
    RunStartedEvent e;
    e.runId = j.value("runId", "");
    return e;
}

// RunFinishedEvent Implementation

nlohmann::json RunFinishedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "RUN_FINISHED";
    j["runId"] = runId;
    j["result"] = result;
    return j;
}

RunFinishedEvent RunFinishedEvent::fromJson(const nlohmann::json& j) {
    RunFinishedEvent e;
    e.runId = j.value("runId", "");
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
    j["stepId"] = stepId;
    return j;
}

StepStartedEvent StepStartedEvent::fromJson(const nlohmann::json& j) {
    StepStartedEvent e;
    e.stepId = j.value("stepId", "");
    return e;
}

// StepFinishedEvent Implementation

nlohmann::json StepFinishedEvent::toJson() const {
    nlohmann::json j;
    j["type"] = "STEP_FINISHED";
    j["stepId"] = stepId;
    return j;
}

StepFinishedEvent StepFinishedEvent::fromJson(const nlohmann::json& j) {
    StepFinishedEvent e;
    e.stepId = j.value("stepId", "");
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
    j["eventType"] = eventType;
    j["data"] = data;
    return j;
}

CustomEvent CustomEvent::fromJson(const nlohmann::json& j) {
    CustomEvent e;
    e.eventType = j.value("eventType", "");
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

        case EventType::ActivitySnapshot:
            return std::unique_ptr<Event>(new ActivitySnapshotEvent(ActivitySnapshotEvent::fromJson(j)));

        case EventType::ActivityDelta:
            return std::unique_ptr<Event>(new ActivityDeltaEvent(ActivityDeltaEvent::fromJson(j)));

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
