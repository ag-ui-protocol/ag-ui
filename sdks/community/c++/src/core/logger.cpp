#include "logger.h"

namespace agui {

std::mutex Logger::s_mutex;
LogCallback Logger::s_callback = nullptr;
LogLevel Logger::s_minLevel = LogLevel::Info;

void Logger::setCallback(LogCallback callback) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_callback = callback;
}

void Logger::setMinLevel(LogLevel level) {
    std::lock_guard<std::mutex> lock(s_mutex);
    s_minLevel = level;
}

void Logger::log(LogLevel level, const std::string& message) {
    LogCallback cb;
    LogLevel minLevel;
    {
      std::lock_guard<std::mutex> lock(s_mutex);
      cb = s_callback;
      minLevel = s_minLevel;
    }
    if (cb && level >= minLevel) {
      try {
        cb(level, message);
      } catch (...) {
        // Never allow user callbacks to corrupt the error-handling path
      }
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
