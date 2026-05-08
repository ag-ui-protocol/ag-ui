#include "error.h"

namespace agui {

AgentError::AgentError(ErrorType type, ErrorCode code, const std::string& message, ErrorSeverity severity)
    : m_type(type), m_code(code), m_message(message), m_severity(severity), m_recoveryStrategy(RecoveryStrategy::None) {
    buildWhatMessage();
}

void AgentError::buildWhatMessage() {
    std::ostringstream oss;
    oss << "[" << errorTypeToString(m_type) << "] "
        << "Code: " << static_cast<int>(m_code) << " - " << m_message;
    m_whatMessage = oss.str();
}

std::string AgentError::errorTypeToString(ErrorType type) {
    switch (type) {
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
