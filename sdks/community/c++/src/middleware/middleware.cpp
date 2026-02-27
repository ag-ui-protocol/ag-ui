#include "middleware/middleware.h"

#include <algorithm>
#include <chrono>
#include <iostream>
#include <thread>

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
        if (!middleware->shouldContinue(input, context)) {
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
    std::cout << "[LoggingMiddleware] Request:" << std::endl;
    std::cout << "  Thread ID: " << input.threadId << std::endl;
    std::cout << "  Run ID: " << input.runId << std::endl;
    std::cout << "  Messages: " << input.messages.size() << std::endl;
    std::cout << "  Tools: " << input.tools.size() << std::endl;

    return input;
}

RunAgentResult LoggingMiddleware::onResponse(const RunAgentResult& result, MiddlewareContext& context) {
    std::cout << "[LoggingMiddleware] Response:" << std::endl;
    std::cout << "  New Messages: " << result.newMessages.size() << std::endl;
    std::cout << "  Has Result: " << (!result.result.empty()) << std::endl;
    std::cout << "  Has New State: " << (!result.newState.empty()) << std::endl;

    return result;
}

std::unique_ptr<Event> LoggingMiddleware::onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) {
    if (event) {
        std::cout << "[LoggingMiddleware] Event: " << EventParser::eventTypeToString(event->type()) << std::endl;
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

RetryMiddleware::RetryMiddleware(int maxRetries, int retryDelay) : m_maxRetries(maxRetries), m_retryDelay(retryDelay) {}

std::unique_ptr<AgentError> RetryMiddleware::onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) {
    if (!error || !context.input) {
        return error;
    }

    std::string requestId = context.input->runId;
    int& retryCount = m_retryCount[requestId];

    if (retryCount < m_maxRetries) {
        retryCount++;

        std::cout << "[RetryMiddleware] Retrying request (attempt " << retryCount << "/" << m_maxRetries << ")"
                  << std::endl;

        std::this_thread::sleep_for(std::chrono::milliseconds(m_retryDelay));
        return nullptr;
    } else {
        m_retryCount.erase(requestId);

        std::cerr << "[RetryMiddleware] Max retries reached, giving up" << std::endl;

        return error;
    }
}

TimeoutMiddleware::TimeoutMiddleware(int timeoutMs) : m_timeoutMs(timeoutMs) {}

RunAgentInput TimeoutMiddleware::onRequest(const RunAgentInput& input, MiddlewareContext& context) {
    context.metadata["timeout_ms"] = std::to_string(m_timeoutMs);
    context.metadata["start_time"] = std::to_string(
        std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
            .count());

    std::cout << "[TimeoutMiddleware] Request timeout set to " << m_timeoutMs << "ms" << std::endl;

    return input;
}

}  // namespace agui
