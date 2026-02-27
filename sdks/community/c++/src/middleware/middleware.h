#pragma once

#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "core/error.h"
#include "core/event.h"
#include "core/session_types.h"

namespace agui {

class IMiddleware;
class MiddlewareChain;

struct MiddlewareContext {
    const RunAgentInput* input;
    RunAgentResult* result;
    
    const std::vector<Message>* currentMessages;
    const std::string *currentState;
    bool shouldContinue;
    
    std::map<std::string, std::string> metadata;

    MiddlewareContext() 
        : input(nullptr), 
          result(nullptr),
          currentMessages(nullptr),
          currentState(nullptr),
          shouldContinue(true) {}

    MiddlewareContext(const RunAgentInput* inp, RunAgentResult* res) 
        : input(inp), 
          result(res),
          currentMessages(nullptr),
          currentState(nullptr),
          shouldContinue(true) {}
};

class IMiddleware {
public:
    virtual ~IMiddleware() = default;

    /**
     * @brief Process request
     * @param input Input parameters
     * @param context Middleware context
     * @return Modified input parameters
     */
    virtual RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) { 
        return input; 
    }

    /**
     * @brief Process response
     * @param result Response result
     * @param context Middleware context
     * @return Modified response result
     */
    virtual RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) { 
        return result; 
    }

    /**
     * @brief Process event
     * @param event Event to process
     * @param context Middleware context
     * @return Modified event
     */
    virtual std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) { 
        return event; 
    }

    /**
     * @brief Process error
     * @param error Error to process
     * @param context Middleware context
     * @return Modified error
     */
    virtual std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) {
        return error;
    }

    /**
     * @brief Determine whether to continue agent execution
     * @param input Input parameters
     * @param context Middleware context
     * @return false to stop execution without calling the agent
     */
    virtual bool shouldContinue(const RunAgentInput& input, MiddlewareContext& context) {
        return true;
    }

    /**
     * @brief Determine whether to process the event
     * @param event Event to check
     * @param context Middleware context
     * @return false to filter out the event
     */
    virtual bool shouldProcessEvent(const Event& event, MiddlewareContext& context) {
        return true;
    }

    /**
     * @brief Generate additional events before the current event
     * @param event Current event
     * @param context Middleware context
     * @return List of events to insert before the current event
     */
    virtual std::vector<std::unique_ptr<Event>> beforeEvent(const Event& event, MiddlewareContext& context) {
        return {};
    }

    /**
     * @brief Generate additional events after the current event
     * @param event Current event
     * @param context Middleware context
     * @return List of events to insert after the current event
     */
    virtual std::vector<std::unique_ptr<Event>> afterEvent(const Event& event, MiddlewareContext& context) {
        return {};
    }
};

class MiddlewareChain {
public:
    MiddlewareChain() = default;

    void addMiddleware(std::shared_ptr<IMiddleware> middleware);
    void removeMiddleware(std::shared_ptr<IMiddleware> middleware);
    void clear();
    size_t size() const { return m_middlewares.size(); }

    /**
     * @brief Process request through middleware chain
     * @param input Input parameters
     * @param context Middleware context
     * @return Modified input parameters
     */
    RunAgentInput processRequest(const RunAgentInput& input, MiddlewareContext& context);

    /**
     * @brief Process response through middleware chain
     * @param result Response result
     * @param context Middleware context
     * @return Modified response result
     */
    RunAgentResult processResponse(const RunAgentResult& result, MiddlewareContext& context);

    /**
     * @brief Process event through middleware chain (enhanced version)
     * @param event Event to process
     * @param context Middleware context
     * @return List of processed events (may include filtered, modified, or generated events)
     * 
     * This method supports:
     * - Event filtering (via shouldProcessEvent)
     * - Event modification (via onEvent)
     * - Event generation (via beforeEvent and afterEvent)
     */
    std::vector<std::unique_ptr<Event>> processEvent(std::unique_ptr<Event> event, MiddlewareContext& context);

    /**
     * @brief Process error through middleware chain
     * @param error Error to process
     * @param context Middleware context
     * @return Modified error
     */
    std::unique_ptr<AgentError> processError(std::unique_ptr<AgentError> error, MiddlewareContext& context);

private:
    std::vector<std::shared_ptr<IMiddleware>> m_middlewares;
};

class LoggingMiddleware : public IMiddleware {
public:
    LoggingMiddleware() = default;

    RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) override;

    RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) override;

    std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override;

    std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) override;
};

class RetryMiddleware : public IMiddleware {
public:
    explicit RetryMiddleware(int maxRetries = 3, int retryDelay = 1000);

    std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) override;

private:
    int m_maxRetries;
    int m_retryDelay;
    std::map<std::string, int> m_retryCount;
};

class TimeoutMiddleware : public IMiddleware {
public:
    explicit TimeoutMiddleware(int timeoutMs = 30000);

    RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) override;

private:
    int m_timeoutMs;
};

}  // namespace agui
