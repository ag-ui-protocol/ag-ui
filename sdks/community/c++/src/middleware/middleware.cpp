#include "middleware/middleware.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <thread>
#include "core/logger.h"

namespace agui {

void MiddlewareChain::addMiddleware(std::shared_ptr<IMiddleware> middleware) {
    if (middleware) {
        m_middlewares.push_back(middleware);
    }
}

void MiddlewareChain::removeMiddleware(std::shared_ptr<IMiddleware> middleware) {
    m_middlewares.erase(std::remove(m_middlewares.begin(), m_middlewares.end(), middleware), m_middlewares.end());
}

void MiddlewareChain::clear() {
    m_middlewares.clear();
}

RunAgentInput MiddlewareChain::processRequest(const RunAgentInput& input, MiddlewareContext& context) {
    RunAgentInput processedInput = input;

    for (auto& middleware : m_middlewares) {
        if (middleware->shouldContinue(input, context)) {
            processedInput = middleware->onRequest(processedInput, context);
        }
    }

    return processedInput;
}

RunAgentResult MiddlewareChain::processResponse(const RunAgentResult& result, MiddlewareContext& context) {
    RunAgentResult processedResult = result;

    for (auto it = m_middlewares.rbegin(); it != m_middlewares.rend(); ++it) {
        processedResult = (*it)->onResponse(processedResult, context);
    }

    return processedResult;
}

std::vector<std::unique_ptr<Event>> MiddlewareChain::processEvent(std::unique_ptr<Event> event, 
                                                                   MiddlewareContext& context) {
    std::vector<std::unique_ptr<Event>> result;
    
    if (!event) {
        return result;
    }

    std::unique_ptr<Event> processedEvent = std::move(event);

    for (auto& middleware : m_middlewares) {
        if (!processedEvent) {
            break;
        }

        // 1. Check if event should be processed (event filtering)
        if (!middleware->shouldProcessEvent(*processedEvent, context)) {
            // Filter out this event, return empty list
            return {};
        }

        // 2. Generate before events
        auto beforeEvents = middleware->beforeEvent(*processedEvent, context);
        for (auto& e : beforeEvents) {
            result.push_back(std::move(e));
        }

        // 3. Process event
        processedEvent = middleware->onEvent(std::move(processedEvent), context);

        // 4. Generate after events
        if (processedEvent) {
            auto afterEvents = middleware->afterEvent(*processedEvent, context);
            for (auto& e : afterEvents) {
                result.push_back(std::move(e));
            }
        }
    }

    // 5. Add processed event
    if (processedEvent) {
        result.push_back(std::move(processedEvent));
    }

    return result;
}

std::unique_ptr<AgentError> MiddlewareChain::processError(std::unique_ptr<AgentError> error,
                                                          MiddlewareContext& context) {
    if (!error) {
        return nullptr;
    }

    std::unique_ptr<AgentError> processedError = std::move(error);

    for (auto it = m_middlewares.rbegin(); it != m_middlewares.rend(); ++it) {
        if (!processedError) {
            break;
        }

        processedError = (*it)->onError(std::move(processedError), context);
    }

    return processedError;
}

RunAgentInput LoggingMiddleware::onRequest(const RunAgentInput& input, MiddlewareContext& context) {
    Logger::debugf("[LoggingMiddleware] Request:");
    Logger::debugf("  Thread ID: %s", input.threadId);
    Logger::debugf("  Run ID: %s", input.runId);
    Logger::debugf("  Messages: %zu", input.messages.size());
    Logger::debugf("  Tools: %zu", input.tools.size());

    return input;
}

RunAgentResult LoggingMiddleware::onResponse(const RunAgentResult& result, MiddlewareContext& context) {
    Logger::debugf("[LoggingMiddleware] Response:");
    Logger::debugf("  New Messages: %zu", result.newMessages.size());
    Logger::debugf("  Has Result: %d", (!result.result.empty()));
    Logger::debugf("  Has New State: %d", (!result.newState.empty()));

    return result;
}

std::unique_ptr<Event> LoggingMiddleware::onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) {
    if (event) {
        Logger::debugf("[LoggingMiddleware] Event: %s", EventParser::eventTypeToString(event->type()));
    }

    return event;
}

std::unique_ptr<AgentError> LoggingMiddleware::onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) {
    if (error) {
        std::cerr << "[LoggingMiddleware] Error:" << std::endl;
        std::cerr << "  Code: " << static_cast<int>(error->code()) << std::endl;
        std::cerr << "  Message: " << error->message() << std::endl;
    }

    return error;
}

}  // namespace agui
