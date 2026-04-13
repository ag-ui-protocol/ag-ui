#pragma once

#include <functional>
#include <mutex>
#include <sstream>
#include <string>

namespace agui {

/**
 * @brief Log level enumeration
 */
enum class LogLevel {
    Debug = 0,    ///< Detailed debug information
    Info = 1,     ///< General informational messages
    Warning = 2,  ///< Warning messages
    Error = 3     ///< Error messages
};

/**
 * @brief Log callback function type
 * @param level The log level
 * @param message The log message
 */
using LogCallback = std::function<void(LogLevel level, const std::string& message)>;

/**
 * @class Logger
 * @brief Simple callback-based logging system for AG-UI SDK
 * 
 * By default, logging is **disabled**. Users can enable logging by setting a callback
 * function that will receive all log messages.
 *
 * We recommend adapting the logging output mechanism to fit different
 * business scenarios and requirements.
 *
 * @par Example Usage
 * @code
 * // Enable logging to stdout
 * agui::Logger::setCallback([](agui::LogLevel level, const std::string& msg) {
 *     const char* levelStr = "";
 *     switch (level) {
 *         case agui::LogLevel::Debug:   levelStr = "DEBUG"; break;
 *         case agui::LogLevel::Info:    levelStr = "INFO"; break;
 *         case agui::LogLevel::Warning: levelStr = "WARN"; break;
 *         case agui::LogLevel::Error:   levelStr = "ERROR"; break;
 *     }
 *     std::cout << "[AGUI][" << levelStr << "] " << msg << std::endl;
 * });
 * 
 * // Set minimum log level
 * agui::Logger::setMinLevel(agui::LogLevel::Info);
 * 
 * // Disable logging
 * agui::Logger::setCallback(nullptr);
 * @endcode
 */
class Logger {
public:
    /**
     * @brief Set the log callback function
     * @param callback Function to handle log messages, or nullptr to disable logging
     * 
     * The callback will be invoked for all log messages that meet the minimum level
     * requirement. Pass nullptr to disable logging.
     */
    static void setCallback(LogCallback callback);
    
    /**
     * @brief Set minimum log level to output
     * @param level Messages below this level will be ignored
     * 
     * Default is LogLevel::Info. Set to LogLevel::Debug to see all messages.
     */
    static void setMinLevel(LogLevel level);
    
    /**
     * @brief Log a message with specified level
     * @param level Log level
     * @param message Log message
     */
    static void log(LogLevel level, const std::string& message);
    
    /**
     * @brief Log a debug message
     * @param message Log message
     */
    static void debug(const std::string& message);
    
    /**
     * @brief Log an info message
     * @param message Log message
     */
    static void info(const std::string& message);
    
    /**
     * @brief Log a warning message
     * @param message Log message
     */
    static void warning(const std::string& message);
    
    /**
     * @brief Log an error message
     * @param message Log message
     */
    static void error(const std::string& message);
    
    /**
     * @brief Format and log a debug message (variadic template version)
     * @tparam Args Argument types
     * @param args Arguments to format
     * 
     * Example: Logger::debugf("Thread ID: ", threadId, ", Count: ", count);
     */
    template<typename... Args>
    static void debugf(Args&&... args) {
        logf(LogLevel::Debug, std::forward<Args>(args)...);
    }
    
    /**
     * @brief Format and log an info message (variadic template version)
     * @tparam Args Argument types
     * @param args Arguments to format
     * 
     * Example: Logger::infof("Agent created with ", count, " messages");
     */
    template<typename... Args>
    static void infof(Args&&... args) {
        logf(LogLevel::Info, std::forward<Args>(args)...);
    }
    
    /**
     * @brief Format and log a warning message (variadic template version)
     * @tparam Args Argument types
     * @param args Arguments to format
     * 
     * Example: Logger::warningf("SSE parser error: ", error);
     */
    template<typename... Args>
    static void warningf(Args&&... args) {
        logf(LogLevel::Warning, std::forward<Args>(args)...);
    }
    
    /**
     * @brief Format and log an error message (variadic template version)
     * @tparam Args Argument types
     * @param args Arguments to format
     * 
     * Example: Logger::errorf("HTTP failed with status: ", statusCode);
     */
    template<typename... Args>
    static void errorf(Args&&... args) {
        logf(LogLevel::Error, std::forward<Args>(args)...);
    }
    
private:
    static std::mutex s_mutex;
    static LogCallback s_callback;
    static LogLevel s_minLevel;
    
    /**
     * @brief Format multiple arguments into a string and log
     * @tparam Args Argument types
     * @param level Log level
     * @param args Arguments to format
     */
    template<typename... Args>
    static void logf(LogLevel level, Args&&... args) {
        std::ostringstream oss;
        (oss << ... << args);
        log(level, oss.str());
    }
};

}  // namespace agui
