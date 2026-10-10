#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <queue>

#include "core/error.h"

namespace agui {

class SseBufferExceededError : public AgentError {
public:
    explicit SseBufferExceededError(const std::string& msg)
        : AgentError(ErrorType::Parse, ErrorCode::ParseSseError, msg) {}
};

class JsonDepthExceededError : public AgentError {
public:
    explicit JsonDepthExceededError(const std::string& msg)
        : AgentError(ErrorType::Parse, ErrorCode::ParseJsonError, msg) {}
};

/**
 * @brief AG-UI SSE parser
 *
 * Splits an SSE byte stream into individual event payloads.
 * Extracts only data: fields and returns them as raw strings;
 * JSON parsing is left to the caller.
 * Ignores event: and id: fields.
 *
 * SSE format:
 * data: {"type": "TEXT_MESSAGE_START", "messageId": "1"}
 *
 * (blank line indicates event end)
 */
class SseParser {
public:
    /// Maximum buffer size (10 MB) to prevent memory exhaustion attacks
    static constexpr size_t kMaxBufferSize = 10 * 1024 * 1024;

    /// Maximum container nesting depth accepted when parsing event JSON.
    /// kMaxBufferSize bounds bytes, not depth: a payload well under it can
    /// still nest deep enough to exhaust the stack in nlohmann's recursive
    /// copy, comparison and dump paths. The outermost object or array is
    /// level 1. AG-UI events themselves are only a few levels deep, so this
    /// leaves ample room for nested state and activity content.
    static constexpr int kMaxJsonDepth = 128;

    SseParser() = default;
    ~SseParser() = default;

    void feed(const std::string& chunk);
    bool hasEvent() const;
    // Check hasEvent() before calling.
    std::string nextEvent();
    void clear();
    // Call when the stream ends to flush any trailing partial event.
    void flush();

private:
    void processBuffer();
    void parseLine(const std::string& line);
    void finishEvent();

    std::string m_buffer;
    std::queue<std::string> m_eventStrings;
    std::string m_currentData;
    size_t m_processed_pos = 0;
};

/**
 * @brief Parse JSON, refusing nesting deeper than SseParser::kMaxJsonDepth.
 *
 * Otherwise identical to nlohmann::json::parse: malformed input still throws
 * nlohmann::json::parse_error. An object or array opening past the limit
 * throws JsonDepthExceededError before it is built.
 */
nlohmann::json parseJsonWithDepthLimit(const std::string& data);

}  // namespace agui
