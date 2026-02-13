#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <queue>

namespace agui {

/**
 * @brief AG-UI SSE parser
 * 
 * Specialized parser for AG-UI protocol SSE streams
 * Features:
 * - Extracts only data: fields
 * - Automatically parses JSON
 * - Returns JSON objects directly
 * - Ignores event: and id: fields
 * 
 * SSE format:
 * data: {"type": "TEXT_MESSAGE_START", "messageId": "1"}
 * 
 * (blank line indicates event end)
 */
class SseParser {
public:
    SseParser();
    ~SseParser();

    /**
     * @brief Feed data chunk to parser
     * @param chunk Data chunk
     */
    void feed(const std::string& chunk);

    /**
     * @brief Check if there are pending events
     * @return true if events are available
     */
    bool hasEvent() const;

    /**
     * @brief Get next event (JSON object)
     * @return JSON object
     * @note Should check hasEvent() before calling
     */
    std::string nextEvent();

    /**
     * @brief Clear all buffers
     */
    void clear();

    /**
     * @brief Flush buffer and process remaining data
     * @note Call when stream ends
     */
    void flush();

    /**
     * @brief Get last error message
     * @return Error message, or empty string if no error
     */
    std::string getLastError() const;

private:
    /**
     * @brief Process data in buffer
     */
    void processBuffer();

    /**
     * @brief Parse a line of data
     * @param line Data line
     */
    void parseLine(const std::string& line);

    /**
     * @brief Finish building current event
     */
    void finishEvent();

    std::string _buffer;
    std::queue<std::string> _eventStrings;
    std::string _lastError;
    std::string _currentData;
};

}  // namespace agui
