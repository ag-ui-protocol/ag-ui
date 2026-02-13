#include "logger.h"

namespace agui {

LogCallback Logger::s_callback = nullptr;
LogLevel Logger::s_minLevel = LogLevel::Info;

void Logger::setCallback(LogCallback callback) {
    s_callback = callback;
}

void Logger::setMinLevel(LogLevel level) {
    s_minLevel = level;
}

void Logger::log(LogLevel level, const std::string& message) {
    // Only log if callback is set and level is sufficient
    if (s_callback && level >= s_minLevel) {
        s_callback(level, message);
    }
}

void Logger::debug(const std::string& message) {
    log(LogLevel::Debug, message);
}

void Logger::info(const std::string& message) {
    log(LogLevel::Info, message);
}

void Logger::warning(const std::string& message) {
    log(LogLevel::Warning, message);
}

void Logger::error(const std::string& message) {
    log(LogLevel::Error, message);
}

}  // namespace agui