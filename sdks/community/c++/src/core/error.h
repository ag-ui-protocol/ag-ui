#pragma once

#include <exception>
#include <sstream>
#include <string>
#include <vector>

namespace agui {

enum class ErrorType { Network, Parse, Execution, Timeout, Validation, State, Unknown };

// Error code format: XYYZZ (5 digits)
// X  - Error type (1-9)
// YY - Sub-type (00-99)
// ZZ - Specific error (00-99)
enum class ErrorCode {
    ValidationError = 10001,

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
    ExecutionCancelled = 40004,

    ValidationInvalidInput = 50001,
    ValidationInvalidState = 50002,
    ValidationInvalidEvent = 50003,
    ValidationInvalidArgument = 50004,

    StateInvalidTransition = 60001,
    StatePatchFailed = 60002,

    Unknown = 99999
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
    ErrorType m_type = ErrorType::Unknown;
    ErrorCode m_code = ErrorCode::Unknown;
    std::string m_message;
    ErrorSeverity m_severity = ErrorSeverity::Info;
    RecoveryStrategy m_recoveryStrategy = RecoveryStrategy::None;
    std::vector<StackFrame> m_stackTrace;
    mutable std::string m_whatMessage;

    void buildWhatMessage();
    static std::string errorTypeToString(ErrorType type);

public:
    AgentError() { buildWhatMessage(); }
    AgentError(ErrorType type, ErrorCode code, const std::string& message,
               ErrorSeverity severity = ErrorSeverity::Error);

    AgentError(const AgentError&) = default;
    AgentError& operator=(const AgentError&) = default;
    AgentError(AgentError&&) noexcept = default;
    AgentError& operator=(AgentError&&) noexcept = default;

    virtual ~AgentError() noexcept = default;

    ErrorType type() const { return m_type; }
    ErrorCode code() const { return m_code; }
    const std::string& message() const { return m_message; }
    ErrorSeverity severity() const { return m_severity; }
    RecoveryStrategy recoveryStrategy() const { return m_recoveryStrategy; }

    const std::vector<StackFrame>& stackTrace() const { return m_stackTrace; }

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

    std::string fullMessage() const {
        std::ostringstream oss;

        oss << "[" << errorTypeToString(m_type) << "] "
            << "Code: " << static_cast<int>(m_code) << " - " << m_message << "\n";

        if (!m_stackTrace.empty()) {
            oss << "Stack Trace:\n";
            for (const auto& frame : m_stackTrace) {
                oss << "  " << frame.toString() << "\n";
            }
        }

        return oss.str();
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

}  // namespace agui
