#pragma once

#include <functional>
#include <string>

#include "core/session_types.h"

namespace agui {

// Forward declarations
class AgentError;

/**
 * @brief Agent execution success callback
 *
 * @param result Execution result
 */
using AgentSuccessCallback = std::function<void(const RunAgentResult& result)>;

/**
 * @brief Agent execution error callback
 *
 * @param error Error message
 */
using AgentErrorCallback = std::function<void(const std::string& error)>;

/**
 * @brief Agent base interface
 *
 * Defines the standard interface for agents
 */
class IAgent {
public:
    virtual ~IAgent() = default;

    /**
     * @brief Run the agent
     *
     * @param params Execution parameters
     * @param onSuccess Success callback
     * @param onError Error callback
     */
    virtual void runAgent(const RunAgentParams& params, AgentSuccessCallback onSuccess, AgentErrorCallback onError) = 0;

    /**
     * @brief Get agent ID
     * @return Agent ID, or empty string if not set
     */
    virtual AgentId agentId() const = 0;
};

}  // namespace agui
