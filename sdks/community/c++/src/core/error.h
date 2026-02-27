#pragma once

#include <exception>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

namespace agui {

enum class ErrorType { Config, Network, Parse, Execution, Timeout, Validation, State, Unknown };

// Error code format: XXYYZZ
// XX - Error type (01-99)
// YY - Sub-type (00-99)
// ZZ - Specific error (00-99)
enum class ErrorCode {
    ConfigInvalidUrl = 10001,
    ConfigMissingRequired = 10002,
    ConfigInvalidFormat = 10003,

    NetworkConnectionFailed = 20001,
    NetworkTimeout = 20002,
    NetworkInvalidResponse = 20003,
    NetworkSslError = 20004,
    NetworkError = 20005,

    ParseJsonError = 30001,
    ParseSseError = 30002,
    ParseEventError = 30003,
    ParseMessageError = 30004,

    ExecutionAgentFailed = 40001,
    ExecutionToolCallFailed = 40002,
    ExecutionStateUpdateFailed = 40003,

    TimeoutRequest = 50001,
    TimeoutResponse = 50002,

    ValidationInvalidInput = 60001,
    ValidationInvalidState = 60002,
    ValidationInvalidEvent = 60003,
    ValidationInvalidArgument = 60004,

    StateInvalidTransition = 70001,
    StatePatchFailed = 70002,

    Unknown = 990000
};

enum class RecoveryStrategy { None, Retry, Fallback, SkipAndContinue };

enum class ErrorSeverity { Debug, Info, Warning, Error, Critical };

struct StackFrame {
    std::string function;
    std::string file;
    int line;

    StackFrame(const std::string& func, const std::string& f, int l) : function(func), file(f), line(l) {}

    std::string toString() const {
        std::ostringstream oss;
        oss << function << " at " << file << ":" << line;
        return oss.str();
    }
};

class AgentError : public std::exception {
private:
    ErrorType m_type;
    ErrorCode m_code;
    std::string m_message;
    ErrorSeverity m_severity;
    RecoveryStrategy m_recoveryStrategy;
    std::vector<StackFrame> m_stackTrace;
    std::map<std::string, std::string> m_context;
    std::unique_ptr<AgentError> m_cause;
    mutable std::string m_whatMessage;

    void buildWhatMessage();
    static std::string errorTypeToString(ErrorType type);

public:
    AgentError() {}
    AgentError(ErrorType type, ErrorCode code, const std::string& message,
               ErrorSeverity severity = ErrorSeverity::Error);

    AgentError(const AgentError& other);
    AgentError& operator=(const AgentError& other);
    AgentError(AgentError&& other) noexcept;
    AgentError& operator=(AgentError&& other) noexcept;

    virtual ~AgentError() noexcept;

    ErrorType type() const { return m_type; }
    ErrorCode code() const { return m_code; }
    const std::string& message() const { return m_message; }
    ErrorSeverity severity() const { return m_severity; }
    RecoveryStrategy recoveryStrategy() const { return m_recoveryStrategy; }

    const std::vector<StackFrame>& stackTrace() const { return m_stackTrace; }
    const std::map<std::string, std::string>& context() const { return m_context; }

    const AgentError* cause() const { return m_cause.get(); }

    virtual const char* what() const noexcept override { return m_whatMessage.c_str(); }

    AgentError& withRecoveryStrategy(RecoveryStrategy strategy) {
        m_recoveryStrategy = strategy;
        return *this;
    }

    AgentError& addStackFrame(const std::string& function, const std::string& file, int line) {
        m_stackTrace.emplace_back(function, file, line);
        buildWhatMessage();
        return *this;
    }

    AgentError& addContext(const std::string& key, const std::string& value) {
        m_context[key] = value;
        buildWhatMessage();
        return *this;
    }

    AgentError& withCause(const AgentError& cause) {
#if __cplusplus >= 201402L
        m_cause = std::make_unique<AgentError>(cause);
#else
        m_cause.reset(new AgentError(cause));
#endif
        buildWhatMessage();
        return *this;
    }

    std::string fullMessage() const {
        std::ostringstream oss;

        oss << "[" << errorTypeToString(m_type) << "] "
            << "Code: " << static_cast<int>(m_code) << " - " << m_message << "\n";

        if (!m_context.empty()) {
            oss << "Context:\n";
#if __cplusplus >= 201703L
            for (const auto& [key, value] : m_context) {
                oss << "  " << key << ": " << value << "\n";
            }
#else
            for (const auto& kv : m_context) {
                oss << "  " << kv.first << ": " << kv.second << "\n";
            }
#endif
        }

        if (!m_stackTrace.empty()) {
            oss << "Stack Trace:\n";
            for (const auto& frame : m_stackTrace) {
                oss << "  " << frame.toString() << "\n";
            }
        }

        if (m_cause) {
            oss << "Caused by:\n";
            oss << m_cause->fullMessage();
        }

        return oss.str();
    }

    static AgentError config(ErrorCode code, const std::string& msg) {
        return AgentError(ErrorType::Config, code, msg);
    }

    static AgentError network(ErrorCode code, const std::string& msg) {
        return AgentError(ErrorType::Network, code, msg);
    }

    static AgentError parse(ErrorCode code, const std::string& msg) { return AgentError(ErrorType::Parse, code, msg); }

    static AgentError execution(ErrorCode code, const std::string& msg) {
        return AgentError(ErrorType::Execution, code, msg);
    }

    static AgentError timeout(ErrorCode code, const std::string& msg) {
        return AgentError(ErrorType::Timeout, code, msg);
    }

    static AgentError validation(ErrorCode code, const std::string& msg) {
        return AgentError(ErrorType::Validation, code, msg);
    }

    static AgentError state(ErrorCode code, const std::string& msg) { return AgentError(ErrorType::State, code, msg); }

    static AgentError unknown(const std::string& msg) {
        return AgentError(ErrorType::Unknown, ErrorCode::Unknown, msg);
    }
};

#define AGUI_ERROR(type, code, message) \
    agui::AgentError::type(code, message).addStackFrame(__FUNCTION__, __FILE__, __LINE__)

#define AGUI_ERROR_WITH_CONTEXT(type, code, message, key, value) \
    agui::AgentError::type(code, message).addStackFrame(__FUNCTION__, __FILE__, __LINE__).addContext(key, value)

}  // namespace agui
