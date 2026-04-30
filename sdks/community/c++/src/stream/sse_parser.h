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

}  // namespace agui
