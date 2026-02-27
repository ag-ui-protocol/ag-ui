#pragma once

#include <chrono>
#include <memory>
#include <nlohmann/json.hpp>
#include <string>

#include "core/error.h"
#include "core/session_types.h"

namespace agui {

/**
 * @brief Event type enumeration (23 event types in total)
 */
enum class EventType {
    // Text message events (4 types)
    TextMessageStart,
    TextMessageContent,
    TextMessageEnd,
    TextMessageChunk,

    // Thinking message events (3 types)
    ThinkingTextMessageStart,
    ThinkingTextMessageContent,
    ThinkingTextMessageEnd,

    // Tool call events (5 types)
    ToolCallStart,
    ToolCallArgs,
    ToolCallEnd,
    ToolCallChunk,
    ToolCallResult,

    // Thinking step events (2 types)
    ThinkingStart,
    ThinkingEnd,

    // State management events (3 types)
    StateSnapshot,
    StateDelta,
    MessagesSnapshot,

    // Run lifecycle events (3 types)
    RunStarted,
    RunFinished,
    RunError,

    // Step events (2 types)
    StepStarted,
    StepFinished,

    // Extension events (2 types)
    Raw,
    Custom
};

/**
 * @brief Base event data containing common information for all events
 */
struct BaseEventData {
    std::chrono::system_clock::time_point timestamp;

#if __cplusplus >= 201703L
    std::optional<nlohmann::json> rawEvent;
#else
    std::unique_ptr<nlohmann::json> rawEvent;
#endif

    BaseEventData();

    nlohmann::json toJson() const;
    static BaseEventData fromJson(const nlohmann::json& j);
};

/**
 * @brief Base event class managed by smart pointers to prevent memory leaks
 */
class Event {
protected:
    BaseEventData m_baseData;

public:
    Event() = default;
    virtual ~Event() = default;

    // Non-copyable, movable
    Event(const Event&) = delete;
    Event& operator=(const Event&) = delete;
    Event(Event&&) = default;
    Event& operator=(Event&&) = default;

    virtual EventType type() const = 0;
    virtual nlohmann::json toJson() const = 0;
    virtual void validate() const {}

    const BaseEventData& baseData() const { return m_baseData; }
    void setRawEvent(const nlohmann::json& raw);
};

/**
 * @brief Text message start event
 */
struct TextMessageStartEvent : public Event {
    MessageId messageId;
    std::string role;

    EventType type() const override { return EventType::TextMessageStart; }
    nlohmann::json toJson() const override;
    static TextMessageStartEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Text message content event
 */
struct TextMessageContentEvent : public Event {
    MessageId messageId;
    std::string delta;

    EventType type() const override { return EventType::TextMessageContent; }
    nlohmann::json toJson() const override;
    static TextMessageContentEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Text message end event
 */
struct TextMessageEndEvent : public Event {
    MessageId messageId;

    EventType type() const override { return EventType::TextMessageEnd; }
    nlohmann::json toJson() const override;
    static TextMessageEndEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Text message chunk event (composite event)
 */
struct TextMessageChunkEvent : public Event {
    MessageId messageId;
    std::string content;

    EventType type() const override { return EventType::TextMessageChunk; }
    nlohmann::json toJson() const override;
    static TextMessageChunkEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Thinking message start event
 */
struct ThinkingTextMessageStartEvent : public Event {

    EventType type() const override { return EventType::ThinkingTextMessageStart; }
    nlohmann::json toJson() const override;
    static ThinkingTextMessageStartEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Thinking message content event
 */
struct ThinkingTextMessageContentEvent : public Event {
    std::string delta;

    EventType type() const override { return EventType::ThinkingTextMessageContent; }
    nlohmann::json toJson() const override;
    static ThinkingTextMessageContentEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Thinking message end event
 */
struct ThinkingTextMessageEndEvent : public Event {

    EventType type() const override { return EventType::ThinkingTextMessageEnd; }
    nlohmann::json toJson() const override;
    static ThinkingTextMessageEndEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Tool call start event
 */
struct ToolCallStartEvent : public Event {
    ToolCallId toolCallId;
    std::string toolCallName;
    MessageId parentMessageId;

    EventType type() const override { return EventType::ToolCallStart; }
    nlohmann::json toJson() const override;
    static ToolCallStartEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Tool call arguments event
 */
struct ToolCallArgsEvent : public Event {
    ToolCallId toolCallId;
    MessageId messageId;
    std::string delta;

    EventType type() const override { return EventType::ToolCallArgs; }
    nlohmann::json toJson() const override;
    static ToolCallArgsEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Tool call end event
 */
struct ToolCallEndEvent : public Event {
    ToolCallId toolCallId;

    EventType type() const override { return EventType::ToolCallEnd; }
    nlohmann::json toJson() const override;
    static ToolCallEndEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Tool call chunk event (composite event)
 */
struct ToolCallChunkEvent : public Event {
    ToolCallId toolCallId;
    std::string toolCallName;
    std::string arguments;

    EventType type() const override { return EventType::ToolCallChunk; }
    nlohmann::json toJson() const override;
    static ToolCallChunkEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Tool call result event
 */
struct ToolCallResultEvent : public Event {
    ToolCallId toolCallId;
    std::string result;

    EventType type() const override { return EventType::ToolCallResult; }
    nlohmann::json toJson() const override;
    static ToolCallResultEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Thinking step start event
 */
struct ThinkingStartEvent : public Event {
    EventType type() const override { return EventType::ThinkingStart; }
    nlohmann::json toJson() const override;
    static ThinkingStartEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Thinking step end event
 */
struct ThinkingEndEvent : public Event {
    EventType type() const override { return EventType::ThinkingEnd; }
    nlohmann::json toJson() const override;
    static ThinkingEndEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief State snapshot event
 */
struct StateSnapshotEvent : public Event {
    nlohmann::json snapshot;

    EventType type() const override { return EventType::StateSnapshot; }
    nlohmann::json toJson() const override;
    static StateSnapshotEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief State delta event
 */
struct StateDeltaEvent : public Event {
    nlohmann::json delta;

    EventType type() const override { return EventType::StateDelta; }
    nlohmann::json toJson() const override;
    static StateDeltaEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Messages snapshot event
 */
struct MessagesSnapshotEvent : public Event {
    std::vector<Message> messages;

    EventType type() const override { return EventType::MessagesSnapshot; }
    nlohmann::json toJson() const override;
    static MessagesSnapshotEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Run started event
 */
struct RunStartedEvent : public Event {
    RunId runId;

    EventType type() const override { return EventType::RunStarted; }
    nlohmann::json toJson() const override;
    static RunStartedEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Run finished event
 */
struct RunFinishedEvent : public Event {
    RunId runId;
    nlohmann::json result;

    EventType type() const override { return EventType::RunFinished; }
    nlohmann::json toJson() const override;
    static RunFinishedEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Run error event
 */
struct RunErrorEvent : public Event {
    std::string error;

    EventType type() const override { return EventType::RunError; }
    nlohmann::json toJson() const override;
    static RunErrorEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Step started event
 */
struct StepStartedEvent : public Event {
    std::string stepId;

    EventType type() const override { return EventType::StepStarted; }
    nlohmann::json toJson() const override;
    static StepStartedEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Step finished event
 */
struct StepFinishedEvent : public Event {
    std::string stepId;

    EventType type() const override { return EventType::StepFinished; }
    nlohmann::json toJson() const override;
    static StepFinishedEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Raw event
 */
struct RawEvent : public Event {
    std::string data;

    EventType type() const override { return EventType::Raw; }
    nlohmann::json toJson() const override;
    static RawEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Custom event
 */
struct CustomEvent : public Event {
    std::string eventType;
    nlohmann::json data;

    EventType type() const override { return EventType::Custom; }
    nlohmann::json toJson() const override;
    static CustomEvent fromJson(const nlohmann::json& j);
};

/**
 * @brief Event parser for parsing JSON data into event objects
 */
class EventParser {
public:
    /**
     * @brief Parse event from JSON
     * @param j JSON data
     * @return Event smart pointer
     * @throws AgentError on parse failure
     */
    static std::unique_ptr<Event> parse(const nlohmann::json& j);

    /**
     * @brief Parse event type from string
     * @param typeStr Type string
     * @return Event type enum
     * @throws AgentError on invalid type
     */
    static EventType parseEventType(const std::string& typeStr);

    /**
     * @brief Convert event type to string
     * @param type Event type
     * @return Type string
     */
    static std::string eventTypeToString(EventType type);
};

}  // namespace agui
