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
    const RunAgentInput* input = nullptr;
    RunAgentResult* result = nullptr;
    
    const std::vector<Message>* currentMessages = nullptr;
    const nlohmann::json* currentState = nullptr;
    bool shouldContinue = true;
    
    std::map<std::string, std::string> metadata;
    MiddlewareContext(const RunAgentInput* inp, RunAgentResult* res) 
        : input(inp), 
          result(res) {}
};

class IMiddleware {
public:
    virtual ~IMiddleware() = default;

    virtual RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) {
        return input;
    }

    virtual RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) {
        return result;
    }

    virtual std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) {
        return event;
    }

    virtual std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) {
        return error;
    }

    // Return false to abort the run before calling the agent.
    virtual bool shouldContinue(const RunAgentInput& input, MiddlewareContext& context) {
        return true;
    }

    // Return false to drop the event from further processing.
    virtual bool shouldProcessEvent(const Event& event, MiddlewareContext& context) {
        return true;
    }

    // Return events to inject before the current event.
    virtual std::vector<std::unique_ptr<Event>> beforeEvent(const Event& event, MiddlewareContext& context) {
        return {};
    }

    // Return events to inject after the current event.
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
    bool empty() const { return m_middlewares.empty(); }

    RunAgentInput processRequest(const RunAgentInput& input, MiddlewareContext& context);
    RunAgentResult processResponse(const RunAgentResult& result, MiddlewareContext& context);

    // Runs shouldProcessEvent → beforeEvent → onEvent → afterEvent for each middleware.
    // Returns the resulting event list (may be empty if filtered, or contain injected events).
    std::vector<std::unique_ptr<Event>> processEvent(std::unique_ptr<Event> event, MiddlewareContext& context);

    // Delivers the error to each middleware's onError in reverse registration order.
    void notifyError(const AgentError& error, MiddlewareContext& context);

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

}  // namespace agui
