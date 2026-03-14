#include "sse_parser.h"

namespace agui {

SseParser::SseParser() {}

SseParser::~SseParser() {}

void SseParser::feed(const std::string& chunk) {
    _buffer += chunk;
    processBuffer();
}

bool SseParser::hasEvent() const {
    return !_eventStrings.empty();
}

std::string SseParser::nextEvent() {
    if (_eventStrings.empty()) {
        return "";
    }
    
    std::string jsonStr = _eventStrings.front();
    _eventStrings.pop();
    return jsonStr;
}

void SseParser::clear() {
    _buffer.clear();
    while (!_eventStrings.empty()) {
        _eventStrings.pop();
    }
    _currentData.clear();
    _lastError.clear();
}

void SseParser::flush() {
    // Force completion of current unfinished event
    if (!_currentData.empty()) {
        finishEvent();
    }
}

std::string SseParser::getLastError() const {
    return _lastError;
}

void SseParser::processBuffer() {
    size_t pos = 0;

    while ((pos = _buffer.find('\n')) != std::string::npos) {
        std::string line = _buffer.substr(0, pos);
        _buffer = _buffer.substr(pos + 1);

        // Remove trailing \r
        if (!line.empty() && line[line.length() - 1] == '\r') {
            line = line.substr(0, line.length() - 1);
        }

        // Empty line indicates end of event
        if (line.empty()) {
            finishEvent();
        } else {
            parseLine(line);
        }
    }
}

void SseParser::parseLine(const std::string& line) {
    // Ignore comment lines
    if (!line.empty() && line[0] == ':') {
        return;
    }

    // Find colon separator
    size_t colonPos = line.find(':');
    if (colonPos == std::string::npos) {
        return;
    }

    std::string field = line.substr(0, colonPos);
    std::string value = line.substr(colonPos + 1);

    // Remove leading space from value
    if (!value.empty() && value[0] == ' ') {
        value = value.substr(1);
    }

    // Only process data field, ignore event and id
    if (field == "data") {
        if (!_currentData.empty()) {
            _currentData += "\n";
        }
        _currentData += value;
    }
    // Ignore other fields (event, id, retry, etc.)
}

void SseParser::finishEvent() {
    // Only create event when there is data
    if (!_currentData.empty()) {
        // Store JSON string directly without parsing here
        _eventStrings.push(_currentData);
        _lastError.clear();

        // Clear current event data
        _currentData.clear();
    }
}

}  // namespace agui
