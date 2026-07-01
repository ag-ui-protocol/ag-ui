#include "middleware/middleware.h"

#include <algorithm>
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
        try {
            if (!middleware->shouldContinue(processedInput, context)) {
                context.shouldContinue = false;
                break;
            }
            processedInput = middleware->onRequest(processedInput, context);
        } catch (const std::exception& e) {
            Logger::errorf("[MiddlewareChain] processRequest: middleware threw: ", e.what());
            throw;
        } catch (...) {
            Logger::errorf("[MiddlewareChain] processRequest: middleware threw unknown exception");
            throw AGUI_ERROR(execution, ErrorCode::ExecutionAgentFailed,
                             "Middleware threw unknown exception during request processing");
        }
        if (!context.shouldContinue) {
            break;
        }
    }

    return processedInput;
}

RunAgentResult MiddlewareChain::processResponse(const RunAgentResult& result, MiddlewareContext& context) {
    RunAgentResult processedResult = result;

    for (auto it = m_middlewares.rbegin(); it != m_middlewares.rend(); ++it) {
        try {
            processedResult = (*it)->onResponse(processedResult, context);
        } catch (const std::exception& e) {
            Logger::errorf("[MiddlewareChain] processResponse: middleware threw: ", e.what());
            throw;  // re-throw: returning a partial result would silently corrupt the response
        } catch (...) {
            Logger::errorf("[MiddlewareChain] processResponse: middleware threw unknown exception");
            throw AGUI_ERROR(execution, ErrorCode::ExecutionAgentFailed,
                             "Middleware threw unknown exception during response processing");
        }
    }

    return processedResult;
}

std::vector<std::unique_ptr<Event>> MiddlewareChain::processEvent(std::unique_ptr<Event> event,
                                                                   MiddlewareContext& context) {
    std::vector<std::unique_ptr<Event>> result;
    // Collect per-middleware afterEvent vectors so they can be appended in reverse
    // order (onion model): M2_after then M1_after, matching the processResponse order.
    std::vector<std::vector<std::unique_ptr<Event>>> perMiddlewareAfterEvents;

    if (!event) {
        return result;
    }

    std::unique_ptr<Event> processedEvent = std::move(event);

    for (auto& middleware : m_middlewares) {
        if (!processedEvent) {
            break;
        }

        try {
            if (!middleware->shouldProcessEvent(*processedEvent, context)) {
                return {};
            }

            auto beforeEvents = middleware->beforeEvent(*processedEvent, context);
            for (auto& e : beforeEvents) {
                result.push_back(std::move(e));
            }

            processedEvent = middleware->onEvent(std::move(processedEvent), context);

            // Collect after events per middleware (appended in reverse order below)
            if (processedEvent) {
                perMiddlewareAfterEvents.push_back(middleware->afterEvent(*processedEvent, context));
            } else {
                perMiddlewareAfterEvents.push_back({});
            }
        } catch (const std::exception& e) {
            Logger::errorf("[MiddlewareChain] processEvent: middleware threw: ", e.what());
            throw;
        } catch (...) {
            Logger::errorf("[MiddlewareChain] processEvent: middleware threw unknown exception");
            throw AGUI_ERROR(execution, ErrorCode::ExecutionAgentFailed,
                             "Middleware threw unknown exception during event processing");
        }
    }

    if (processedEvent) {
        result.push_back(std::move(processedEvent));
    }

    // 6. Append after events in reverse middleware order (onion model)
    for (auto it = perMiddlewareAfterEvents.rbegin(); it != perMiddlewareAfterEvents.rend(); ++it) {
        for (auto& e : *it) {
            result.push_back(std::move(e));
        }
    }

    return result;
}

void MiddlewareChain::notifyError(const AgentError& error, MiddlewareContext& context) {
    // Notify in reverse order (onion model), matching processResponse.
    // Reconstruct errorPtr for each middleware so that a middleware that throws
    // or consumes the ptr does not silently skip subsequent notifications.
    for (auto it = m_middlewares.rbegin(); it != m_middlewares.rend(); ++it) {
        auto errorPtr = std::make_unique<AgentError>(error);
        try {
            errorPtr = (*it)->onError(std::move(errorPtr), context);
        } catch (const std::exception& e) {
            Logger::errorf("[MiddlewareChain] notifyError: middleware threw: ", e.what());
        } catch (...) {
            Logger::errorf("[MiddlewareChain] notifyError: middleware threw unknown exception");
        }
    }
}

RunAgentInput LoggingMiddleware::onRequest(const RunAgentInput& input, MiddlewareContext& context) {
    Logger::debugf("[LoggingMiddleware] Request:");
    Logger::debugf("  Thread ID: ", input.threadId);
    Logger::debugf("  Run ID: ", input.runId);
    Logger::debugf("  Messages: ", input.messages.size());
    Logger::debugf("  Tools: ", input.tools.size());

    return input;
}

RunAgentResult LoggingMiddleware::onResponse(const RunAgentResult& result, MiddlewareContext& context) {
    Logger::debugf("[LoggingMiddleware] Response:");
    Logger::debugf("  New Messages: ", result.newMessages.size());
    Logger::debugf("  Has Result: ", (!result.result.empty()));
    Logger::debugf("  Has New State: ", (!result.newState.empty()));

    return result;
}

std::unique_ptr<Event> LoggingMiddleware::onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) {
    if (event) {
        Logger::debugf("[LoggingMiddleware] Event: ", EventParser::eventTypeToString(event->type()));
    }

    return event;
}

std::unique_ptr<AgentError> LoggingMiddleware::onError(std::unique_ptr<AgentError> error, MiddlewareContext& context) {
    if (error) {
        Logger::errorf("[LoggingMiddleware] Error:");
        Logger::errorf("  Code: ", static_cast<int>(error->code()));
        Logger::errorf("  Message: ", error->message());
    }

    return error;
}

}  // namespace agui
