#include "http_agent.h"

#include <nlohmann/json.hpp>
#include <set>

#include "core/logger.h"
#include "core/subscriber.h"
#include "core/uuid.h"

namespace agui {

// Builder Implementation

HttpAgent::Builder::Builder() : m_timeout(30) {}

HttpAgent::Builder& HttpAgent::Builder::withUrl(const std::string& url) {
    m_url = url;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withHeader(const std::string& name, const std::string& value) {
    m_headers[name] = value;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withBearerToken(const std::string& token) {
    m_headers["Authorization"] = "Bearer " + token;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withTimeout(uint32_t seconds) {
    m_timeout = seconds;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withAgentId(const AgentId& id) {
    m_agentId = id;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withInitialMessages(const std::vector<Message>& messages) {
    m_initialMessages = messages;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withInitialState(const nlohmann::json& state) {
    m_initialState = state;
    return *this;
}

std::unique_ptr<HttpAgent> HttpAgent::Builder::build() {
    if (m_url.empty()) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationError, "Base URL is required");
    }

    // Set default Content-Type
    if (m_headers.find("Content-Type") == m_headers.end()) {
        m_headers["Content-Type"] = "application/json";
    }

    return std::make_unique<HttpAgent>(ConstructorAccess{}, m_url, m_headers, m_agentId,
                                        m_initialMessages, m_initialState, m_timeout);
}

HttpAgent::Builder HttpAgent::builder() {
    return Builder();
}

// HttpAgent Implementation

HttpAgent::HttpAgent(Builder::ConstructorAccess,
                     const std::string& baseUrl, const std::map<std::string, std::string>& headers,
                     const AgentId& agentId, const std::vector<Message>& initialMessages,
                     const nlohmann::json& initialState, uint32_t timeoutSeconds)
    : m_baseUrl(baseUrl), m_headers(headers), m_agentId(agentId), m_timeoutSeconds(timeoutSeconds) {
    m_httpService = std::make_unique<HttpService>();
    m_sseParser = std::make_unique<SseParser>();

    m_eventHandler = std::make_shared<EventHandler>(initialMessages, initialState,
                                                    std::vector<std::shared_ptr<IAgentSubscriber>>());

    Logger::infof("HttpAgent created with ", initialMessages.size(), " initial messages");
}

HttpAgent::~HttpAgent() {}

AgentId HttpAgent::agentId() const {
    return m_agentId;
}

// State access (delegated to EventHandler)

const std::vector<Message>& HttpAgent::messages() const {
    return m_eventHandler->messages();
}

const nlohmann::json& HttpAgent::state() const {
    return m_eventHandler->state();
}

// State modification (delegated to EventHandler)

void HttpAgent::addMessage(const Message& message) {
    auto msgs = m_eventHandler->messages();
    msgs.push_back(message);

    AgentStateMutation mutation;
    mutation.withMessages(msgs);
    m_eventHandler->applyMutation(mutation);

    Logger::infof("Message added, total messages: ", msgs.size());
}

void HttpAgent::setMessages(const std::vector<Message>& messages) {
    AgentStateMutation mutation;
    mutation.withMessages(messages);
    m_eventHandler->applyMutation(mutation);

    Logger::infof("Messages set, total messages: ", messages.size());
}

void HttpAgent::setState(const nlohmann::json& state) {
    AgentStateMutation mutation;
    mutation.withState(state);
    m_eventHandler->applyMutation(mutation);

    Logger::info("State updated");
}

// Subscriber management (delegated to EventHandler)

void HttpAgent::subscribe(std::shared_ptr<IAgentSubscriber> subscriber) {
    m_eventHandler->addSubscriber(subscriber);
    Logger::info("Subscriber added");
}

void HttpAgent::unsubscribe(std::shared_ptr<IAgentSubscriber> subscriber) {
    m_eventHandler->removeSubscriber(subscriber);
    Logger::info("Subscriber removed");
}

void HttpAgent::clearSubscribers() {
    m_eventHandler->clearSubscribers();
    Logger::info("All subscribers cleared");
}

// Middleware management

HttpAgent& HttpAgent::use(std::shared_ptr<IMiddleware> middleware) {
    m_middlewareChain.addMiddleware(middleware);
    Logger::infof("Middleware added, total: ", m_middlewareChain.size());
    return *this;
}

MiddlewareChain& HttpAgent::middlewareChain() {
    return m_middlewareChain;
}

void HttpAgent::setHttpService(std::unique_ptr<IHttpService> service) {
    m_httpService = std::move(service);
}

void HttpAgent::cancelRun() {
    if (!m_currentRunKey.empty()) {
        m_httpService->cancelRequest(m_currentRunKey);
    }
}

// runAgent implementation

void HttpAgent::runAgent(const RunAgentParams& params, AgentSuccessCallback onSuccess, AgentErrorCallback onError) {
    Logger::info("Starting agent run");

    m_runErrorOccurred = false;
    m_runErrorMessage.clear();
    m_runError.reset();
    m_eventVerifier.reset();

    // Snapshot message IDs present before this run so we can compute the delta later
    m_preRunMessageIds.clear();
    for (const auto& msg : m_eventHandler->messages()) {
        m_preRunMessageIds.insert(msg.id());
    }

    // Reset result from previous run
    m_eventHandler->clearResult();

    // Clear SSE parser for new request
    m_sseParser->clear();

    // Clear streaming buffers so stale data from any previous run cannot leak into this one
    m_eventHandler->clearBuffers();

    // Build RunAgentInput with current messages and state
    RunAgentInput input;
    input.threadId = params.threadId.empty() ? UuidGenerator::generate() : params.threadId;
    input.runId = params.runId.empty() ? UuidGenerator::generate() : params.runId;
    input.parentRunId = params.parentRunId;
    input.state = params.state.is_null() ? m_eventHandler->state() : params.state;
    input.messages = m_eventHandler->messages();
    for (const auto& msg : params.messages) {
        input.messages.push_back(msg);
    }
    input.tools = params.tools;
    input.context = params.context;
    input.forwardedProps = params.forwardedProps;

    Logger::debugf("Thread ID: ", input.threadId);
    Logger::debugf("Run ID: ", input.runId);
    Logger::debugf("Messages count: ", input.messages.size());

    // Process request through middleware
    MiddlewareContext middlewareContext(&input, nullptr);
    middlewareContext.currentMessages = &m_eventHandler->messages();
    middlewareContext.currentState = &m_eventHandler->state();
    
    if (!m_middlewareChain.empty()) {
        Logger::infof("Processing request through ", m_middlewareChain.size(), " middlewares");
        try {
            input = m_middlewareChain.processRequest(input, middlewareContext);
        } catch (const std::exception& e) {
            Logger::errorf("Request middleware failed: ", e.what());
            if (onError) {
                invokeErrorCallback(onError, std::string("Request middleware failed: ") + e.what());
            }
            return;
        }

        if (!middlewareContext.shouldContinue) {
            Logger::errorf("Middleware stopped execution");
            if (onError) {
                invokeErrorCallback(onError, "Middleware stopped execution");
            }
            return;
        }
    }

    m_currentInput = input;  // persisted so SSE-phase middleware context can reference it
    m_currentRunKey = input.runId;

    // Add per-run subscribers to EventHandler (tracked for cleanup after run)
    m_perRunSubscribers = params.subscribers;
    for (auto& subscriber : m_perRunSubscribers) {
        m_eventHandler->addSubscriber(subscriber);
    }
    Logger::debugf("Per-run subscribers added: ", m_perRunSubscribers.size());

    // Wrapped so serialisation exceptions still clean up subscribers and invoke onError.
    try {
        HttpRequest request;
        request.url = m_baseUrl;
        request.method = HttpMethod::POST;
        request.headers = m_headers;
        request.body = input.toJson().dump();
        // Clamp before multiply to avoid signed integer overflow (max ~24.8 days).
        static constexpr uint32_t kMaxTimeoutSeconds = 2'147'483u;
        request.timeoutMs = static_cast<int>(std::min(m_timeoutSeconds, kMaxTimeoutSeconds)) * 1000;
        request.cancelKey = m_currentRunKey;

        Logger::debugf("Sending request to ", m_baseUrl);
        Logger::debugf("Request body size: ", request.body.size(), " bytes");

        m_httpService->sendSseRequest(
            request,
            // onData: Incremental processing of SSE chunks
            [this](const HttpResponse& response) {
                this->handleStreamData(response);
            },
            // onComplete: Final processing when stream ends
            [this, onSuccess, onError](const HttpResponse& response) {
                this->handleStreamComplete(response, onSuccess, onError);
            },
            [this, onSuccess, onError](const AgentError& error) {
                Logger::errorf("SSE request error: ", error.fullMessage());
                if (!m_middlewareChain.empty()) {
                    MiddlewareContext ctx(&m_currentInput, nullptr);
                    ctx.currentMessages = &m_eventHandler->messages();
                    ctx.currentState = &m_eventHandler->state();
                    m_middlewareChain.notifyError(error, ctx);
                }
                m_eventHandler->notifyRunFailed(error);
                m_eventHandler->notifyRunFinalized();
                cleanupPerRunSubscribers();
                if (onError) {
                    invokeErrorCallback(onError, error.fullMessage());
                }
            });
    } catch (const std::exception& e) {
        Logger::errorf("Failed to build or send request: ", e.what());
        AgentError buildErr(ErrorType::Execution, ErrorCode::ExecutionAgentFailed,
                            std::string("Failed to start agent run: ") + e.what());
        m_eventHandler->notifyRunFailed(buildErr);
        m_eventHandler->notifyRunFinalized();
        cleanupPerRunSubscribers();
        if (onError) {
            invokeErrorCallback(onError, std::string("Failed to start agent run: ") + e.what());
        }
    }
}

void HttpAgent::cleanupPerRunSubscribers() {
    for (auto& subscriber : m_perRunSubscribers) {
        m_eventHandler->removeSubscriber(subscriber);
    }
    m_perRunSubscribers.clear();
}

void HttpAgent::handleStreamData(const HttpResponse& response) {
    if (m_runErrorOccurred) {
        Logger::warning("Ignoring SSE chunk after run entered error state");
        return;
    }

    try {
        m_sseParser->feed(response.content);
        processAvailableEvents();
    } catch (const AgentError& e) {
        Logger::errorf("Fatal error feeding SSE data: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = e.what();
        m_runError = e;  // preserve original type/code for notifyRunFailed
    } catch (const std::exception& e) {
        Logger::errorf("Fatal error feeding SSE data: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = std::string("SSE stream error: ") + e.what();
    }
}

bool HttpAgent::processSingleEvent(std::unique_ptr<Event> event, MiddlewareContext& middlewareContext) {
    m_eventVerifier.verify(*event);

    bool isRunError = (event->type() == EventType::RunError);
    bool isRunFinished = (event->type() == EventType::RunFinished);
    std::string runErrorMsg;

    if (isRunError) {
        const auto* runErr = dynamic_cast<const RunErrorEvent*>(event.get());
        if (runErr) {
            runErrorMsg = runErr->message;
        } else {
            Logger::warningf("processSingleEvent: RunError type flag set but dynamic_cast to RunErrorEvent failed");
        }
    }

    AgentStateMutation mutation = m_eventHandler->handleEvent(std::move(event));
    if (mutation.hasChanges()) {
        m_eventHandler->applyMutation(mutation);
        middlewareContext.currentMessages = &m_eventHandler->messages();
        middlewareContext.currentState = &m_eventHandler->state();
    }

    if (isRunFinished && !m_eventVerifier.isComplete()) {
        std::string details;
        const auto incompleteMessages = m_eventVerifier.getIncompleteMessages();
        const auto incompleteToolCalls = m_eventVerifier.getIncompleteToolCalls();

        if (!incompleteMessages.empty()) {
            details += " incomplete messages:";
            for (const auto& messageId : incompleteMessages) {
                details += " " + messageId;
            }
        }

        if (!incompleteToolCalls.empty()) {
            details += " incomplete tool calls:";
            for (const auto& toolCallId : incompleteToolCalls) {
                details += " " + toolCallId;
            }
        }

        throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidEvent,
                         "RUN_FINISHED received before all lifecycle events completed." + details);
    }

    if (isRunError) {
        m_runErrorOccurred = true;
        m_runErrorMessage = runErrorMsg.empty() ? "Agent reported a run error" : runErrorMsg;
        return true;
    }

    return false;
}

std::unique_ptr<Event> HttpAgent::parseSseEventData(const std::string& eventData) {
    // Parse raw SSE data. Any malformed JSON inside a `data:` payload is a
    // protocol error and must terminate the run instead of being skipped.
    nlohmann::json eventJson;
    try {
        eventJson = nlohmann::json::parse(eventData);
    } catch (const nlohmann::json::parse_error& e) {
        throw AGUI_ERROR(parse, ErrorCode::ParseJsonError,
                         std::string("Malformed SSE event payload: ") + e.what());
    }

    if (!eventJson.contains("type") || !eventJson["type"].is_string()) {
        throw AGUI_ERROR(parse, ErrorCode::ParseEventError,
                         "Event JSON missing string 'type' field");
    }

    const std::string typeStr = eventJson["type"].get<std::string>();

    // Unknown event types (e.g. from a newer server) are skipped with a
    // warning to preserve forward-compatibility. Once the type is known, any
    // parse or validation error is fatal and must propagate.
    try {
        (void)EventParser::parseEventType(typeStr);
    } catch (const AgentError& e) {
        Logger::warningf("skip unknown event type: ", e.what());
        return nullptr;
    }

    std::unique_ptr<Event> event = EventParser::parse(eventJson);
    return event;
}

void HttpAgent::processAvailableEvents() {
    // Prepare middleware context — pass m_currentInput so middleware can access the run input
    MiddlewareContext middlewareContext(&m_currentInput, nullptr);
    middlewareContext.currentMessages = &m_eventHandler->messages();
    middlewareContext.currentState = &m_eventHandler->state();

    while (m_sseParser->hasEvent()) {
        if (!processNextEvent(middlewareContext)) {
            break;
        }
    }
}

bool HttpAgent::processNextEvent(MiddlewareContext& middlewareContext) {
    try {
        const std::string& eventData = m_sseParser->nextEvent();
        if (eventData.empty()) {
            return true;
        }

        std::unique_ptr<Event> event = parseSseEventData(eventData);
        if (!event) {
            // Unknown-but-well-formed event type (forward-compatibility): skip and continue.
            // Truly malformed events throw instead of returning nullptr.
            return true;
        }
        event->validate();

        std::vector<std::unique_ptr<Event>> eventsToProcess;
        if (!m_middlewareChain.empty()) {
            eventsToProcess = m_middlewareChain.processEvent(std::move(event), middlewareContext);
        } else {
            eventsToProcess.push_back(std::move(event));
        }

        for (auto& processedEvent : eventsToProcess) {
            if (processSingleEvent(std::move(processedEvent), middlewareContext)) {
                return false;
            }
        }
        return true;
    } catch (const AgentError& e) {
        Logger::errorf("Fatal error processing event: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = e.what();
        m_runError = e;  // preserve original type/code for notifyRunFailed
        return false;
    } catch (const std::exception& e) {
        Logger::errorf("Fatal error processing event: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = std::string("Event processing error: ") + e.what();
        return false;
    }
}

void HttpAgent::handleStreamComplete(const HttpResponse& response, AgentSuccessCallback onSuccess,
                                     AgentErrorCallback onError) {
    if (response.cancelled) {
        Logger::info("Agent run was cancelled by user");
        AgentError cancelErr(ErrorType::Execution, ErrorCode::ExecutionCancelled,
                             "Agent run was cancelled by user");
        if (!m_middlewareChain.empty()) {
            MiddlewareContext ctx(&m_currentInput, nullptr);
            ctx.currentMessages = &m_eventHandler->messages();
            ctx.currentState = &m_eventHandler->state();
            m_middlewareChain.notifyError(cancelErr, ctx);
        }
        m_eventHandler->notifyRunFailed(cancelErr);
        m_eventHandler->notifyRunFinalized();
        cleanupPerRunSubscribers();
        if (onError) {
            invokeErrorCallback(onError, "Agent run was cancelled");
        }
        return;
    }

    if (!response.isSuccess()) {
        Logger::errorf("HTTP request failed with status: ", response.statusCode);
        AgentError httpErr(ErrorType::Network, ErrorCode::NetworkInvalidResponse,
                           "HTTP request failed with status: " + std::to_string(response.statusCode));
        if (!m_middlewareChain.empty()) {
            MiddlewareContext ctx(&m_currentInput, nullptr);
            ctx.currentMessages = &m_eventHandler->messages();
            ctx.currentState = &m_eventHandler->state();
            m_middlewareChain.notifyError(httpErr, ctx);
        }
        m_eventHandler->notifyRunFailed(httpErr);
        m_eventHandler->notifyRunFinalized();
        cleanupPerRunSubscribers();
        if (onError) {
            invokeErrorCallback(onError, "HTTP request failed with status: " + std::to_string(response.statusCode));
        }
        return;
    }

    Logger::info("Stream complete, flushing remaining data");
    try {
        m_sseParser->flush();
    } catch (const AgentError& e) {
        Logger::errorf("Fatal error during SSE flush: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = e.what();
        m_runError = e;
    } catch (const std::exception& e) {
        Logger::errorf("Fatal error during SSE flush: ", e.what());
        m_runErrorOccurred = true;
        m_runErrorMessage = std::string("SSE flush error: ") + e.what();
    }

    if (!m_runErrorOccurred) {
        processAvailableEvents();
    }

    if (m_runErrorOccurred) {
        Logger::errorf("Run terminated with error: ", m_runErrorMessage);
        // Use the original AgentError if available; fall back to ExecutionAgentFailed otherwise.
        AgentError runErr = m_runError.has_value()
            ? *m_runError
            : AgentError(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, m_runErrorMessage);
        if (!m_middlewareChain.empty()) {
            MiddlewareContext ctx(&m_currentInput, nullptr);
            ctx.currentMessages = &m_eventHandler->messages();
            ctx.currentState = &m_eventHandler->state();
            m_middlewareChain.notifyError(runErr, ctx);
        }
        m_eventHandler->notifyRunFailed(runErr);
        m_eventHandler->notifyRunFinalized();
        cleanupPerRunSubscribers();
        if (onError) {
            invokeErrorCallback(onError, m_runErrorMessage);
        }
        return;
    }

    // onSuccess is outside this try block: wrapping it would cause notifyRunFailed
    // to fire on a run that already succeeded.
    RunAgentResult result;
    try {
        result = collectResults();

        if (!m_middlewareChain.empty()) {
            Logger::infof("Processing response through ", m_middlewareChain.size(), " middlewares");
            MiddlewareContext middlewareContext(&m_currentInput, &result);
            middlewareContext.currentMessages = &m_eventHandler->messages();
            middlewareContext.currentState = &m_eventHandler->state();
            result = m_middlewareChain.processResponse(result, middlewareContext);
        }
    } catch (const std::exception& e) {
        Logger::errorf("Error in result collection or response middleware: ", e.what());
        AgentError completionErr(ErrorType::Execution, ErrorCode::ExecutionAgentFailed,
                                 std::string("Error completing run: ") + e.what());
        m_eventHandler->notifyRunFailed(completionErr);
        m_eventHandler->notifyRunFinalized();
        cleanupPerRunSubscribers();
        if (onError) {
            invokeErrorCallback(onError, std::string("Error completing run: ") + e.what());
        }
        return;
    }

    m_eventHandler->notifyRunFinalized();
    cleanupPerRunSubscribers();

    if (onSuccess) {
        try {
            onSuccess(result);
        } catch (const std::exception& e) {
            Logger::errorf("onSuccess callback threw an exception (run already succeeded): ", e.what());
        } catch (...) {
            Logger::errorf("onSuccess callback threw an unknown exception (run already succeeded)");
        }
    }
}

RunAgentResult HttpAgent::collectResults() {
    RunAgentResult result;
    result.newState = m_eventHandler->state();
    result.result = m_eventHandler->result();

    for (const auto& msg : m_eventHandler->messages()) {
        if (m_preRunMessageIds.find(msg.id()) == m_preRunMessageIds.end()) {
            result.newMessages.push_back(msg);
        }
    }

    return result;
}

void HttpAgent::invokeErrorCallback(AgentErrorCallback onError, const std::string& errorMessage) {
    try {
        onError(errorMessage);
    } catch (const std::exception& ex) {
        Logger::errorf("onError callback threw: ", ex.what());
    } catch (...) {
        Logger::errorf("onError callback threw unknown exception");
    }
}

}  // namespace agui
