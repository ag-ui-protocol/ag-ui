#include "error.h"

namespace agui {

AgentError::AgentError(ErrorType type, ErrorCode code, const std::string& message, ErrorSeverity severity)
    : m_type(type), m_code(code), m_message(message), m_severity(severity), m_recoveryStrategy(RecoveryStrategy::None) {
    buildWhatMessage();
}

AgentError::AgentError(const AgentError& other)
    : m_type(other.m_type),
      m_code(other.m_code),
      m_message(other.m_message),
      m_severity(other.m_severity),
      m_recoveryStrategy(other.m_recoveryStrategy),
      m_stackTrace(other.m_stackTrace),
      m_context(other.m_context),
      m_whatMessage(other.m_whatMessage) {
    if (other.m_cause) {
        m_cause = std::make_unique<AgentError>(*other.m_cause);
    }
}

AgentError& AgentError::operator=(const AgentError& other) {
    if (this != &other) {
        m_type = other.m_type;
        m_code = other.m_code;
        m_message = other.m_message;
        m_severity = other.m_severity;
        m_recoveryStrategy = other.m_recoveryStrategy;
        m_stackTrace = other.m_stackTrace;
        m_context = other.m_context;
        m_whatMessage = other.m_whatMessage;
        if (other.m_cause) {
            m_cause = std::make_unique<AgentError>(*other.m_cause);
        } else {
            m_cause.reset();
        }
    }
    return *this;
}

AgentError::AgentError(AgentError&& other) noexcept
    : m_type(other.m_type),
      m_code(other.m_code),
      m_message(std::move(other.m_message)),
      m_severity(other.m_severity),
      m_recoveryStrategy(other.m_recoveryStrategy),
      m_stackTrace(std::move(other.m_stackTrace)),
      m_context(std::move(other.m_context)),
      m_cause(std::move(other.m_cause)),
      m_whatMessage(std::move(other.m_whatMessage)) {}

AgentError& AgentError::operator=(AgentError&& other) noexcept {
    if (this != &other) {
        m_type = other.m_type;
        m_code = other.m_code;
        m_message = std::move(other.m_message);
        m_severity = other.m_severity;
        m_recoveryStrategy = other.m_recoveryStrategy;
        m_stackTrace = std::move(other.m_stackTrace);
        m_context = std::move(other.m_context);
        m_cause = std::move(other.m_cause);
        m_whatMessage = std::move(other.m_whatMessage);
    }
    return *this;
}

AgentError::~AgentError() noexcept {}

void AgentError::buildWhatMessage() {
    std::ostringstream oss;
    oss << "[" << errorTypeToString(m_type) << "] "
        << "Code: " << static_cast<int>(m_code) << " - " << m_message;
    m_whatMessage = oss.str();
}

std::string AgentError::errorTypeToString(ErrorType type) {
    switch (type) {
        case ErrorType::Config:
            return "Config";
        case ErrorType::Network:
            return "Network";
        case ErrorType::Parse:
            return "Parse";
        case ErrorType::Execution:
            return "Execution";
        case ErrorType::Timeout:
            return "Timeout";
        case ErrorType::Validation:
            return "Validation";
        case ErrorType::State:
            return "State";
        case ErrorType::Unknown:
            return "Unknown";
        default:
            return "Unknown";
    }
}

}  // namespace agui
