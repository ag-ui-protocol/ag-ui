#include "http_agent.h"

#include <nlohmann/json.hpp>
#include <set>

#include "core/logger.h"
#include "core/subscriber.h"
#include "core/uuid.h"

namespace agui {

// Builder Implementation

HttpAgent::Builder::Builder() : _timeout(30) {}

HttpAgent::Builder& HttpAgent::Builder::withUrl(const std::string& url) {
    _url = url;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withHeader(const std::string& name, const std::string& value) {
    _headers[name] = value;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withBearerToken(const std::string& token) {
    _headers["Authorization"] = "Bearer " + token;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withTimeout(uint32_t seconds) {
    _timeout = seconds;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withAgentId(const AgentId& id) {
    _agentId = id;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withInitialMessages(const std::vector<Message>& messages) {
    _initialMessages = messages;
    return *this;
}

HttpAgent::Builder& HttpAgent::Builder::withInitialState(const nlohmann::json& state) {
    _initialState = state;
    return *this;
}

std::unique_ptr<HttpAgent> HttpAgent::Builder::build() {
    if (_url.empty()) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationError, "Base URL is required");
    }

    // Set default Content-Type
    if (_headers.find("Content-Type") == _headers.end()) {
        _headers["Content-Type"] = "application/json";
    }

    return std::unique_ptr<HttpAgent>(new HttpAgent(_url, _headers, _agentId, _initialMessages, _initialState));
}

HttpAgent::Builder HttpAgent::builder() {
    return Builder();
}

// HttpAgent Implementation

HttpAgent::HttpAgent(const std::string& baseUrl, const std::map<std::string, std::string>& headers,
                     const AgentId& agentId, const std::vector<Message>& initialMessages,
                     const std::string& initialState)
    : _baseUrl(baseUrl), _headers(headers), _agentId(agentId) {
    _httpService = std::unique_ptr<HttpService>(new HttpService());
    _sseParser = std::unique_ptr<SseParser>(new SseParser());

    // Create persistent EventHandler
    _eventHandler = std::make_shared<EventHandler>(initialMessages, initialState,
                                                    std::vector<std::shared_ptr<IAgentSubscriber>>());

    Logger::infof("HttpAgent created with ", initialMessages.size(), " initial messages");
}

HttpAgent::~HttpAgent() {}

AgentId HttpAgent::agentId() const {
    return _agentId;
}

// State access (delegated to EventHandler)

const std::vector<Message>& HttpAgent::messages() const {
    return _eventHandler->messages();
}

const std::string& HttpAgent::state() const {
    return _eventHandler->state();
}

// State modification (delegated to EventHandler)

void HttpAgent::addMessage(const Message& message) {
    // Get current messages and add new message
    auto msgs = _eventHandler->messages();
    msgs.push_back(message);

    // Create and apply mutation
    AgentStateMutation mutation;
    mutation.withMessages(msgs);
    _eventHandler->applyMutation(mutation);

    Logger::infof("Message added, total messages: ", msgs.size());
}

void HttpAgent::setMessages(const std::vector<Message>& messages) {
    AgentStateMutation mutation;
    mutation.withMessages(messages);
    _eventHandler->applyMutation(mutation);

    Logger::infof("Messages set, total messages: ", messages.size());
}

void HttpAgent::setState(const nlohmann::json& state) {
    AgentStateMutation mutation;
    mutation.withState(state);
    _eventHandler->applyMutation(mutation);

    Logger::info("State updated");
}

// Subscriber management (delegated to EventHandler)

void HttpAgent::subscribe(std::shared_ptr<IAgentSubscriber> subscriber) {
    _eventHandler->addSubscriber(subscriber);
    Logger::info("Subscriber added");
}

void HttpAgent::unsubscribe(std::shared_ptr<IAgentSubscriber> subscriber) {
    _eventHandler->removeSubscriber(subscriber);
    Logger::info("Subscriber removed");
}

void HttpAgent::clearSubscribers() {
    _eventHandler->clearSubscribers();
    Logger::info("All subscribers cleared");
}

// Middleware management

HttpAgent& HttpAgent::use(std::shared_ptr<IMiddleware> middleware) {
    _middlewareChain.addMiddleware(middleware);
    Logger::infof("Middleware added, total: ", _middlewareChain.size());
    return *this;
}

MiddlewareChain& HttpAgent::middlewareChain() {
    return _middlewareChain;
}

// runAgent implementation

void HttpAgent::runAgent(const RunAgentParams& params, AgentSuccessCallback onSuccess, AgentErrorCallback onError) {
    Logger::info("Starting agent run");

    _currentErrorCallback = onError;

    // Clear SSE parser for new request
    _sseParser->clear();

    // 1. Build RunAgentInput with current messages and state
    RunAgentInput input;
    input.threadId = params.threadId.empty() ? UuidGenerator::generate() : params.threadId;
    input.runId = params.runId.empty() ? UuidGenerator::generate() : params.runId;
    input.state = _eventHandler->state();
    input.messages = _eventHandler->messages();
    input.tools = params.tools;
    input.context = params.context;
    input.forwardedProps = params.forwardedProps;

    Logger::debugf("Thread ID: ", input.threadId);
    Logger::debugf("Run ID: ", input.runId);
    Logger::debugf("Messages count: ", input.messages.size());

    // 2. Process request through middleware
    MiddlewareContext middlewareContext(&input, nullptr);
    middlewareContext.currentMessages = &_eventHandler->messages();
    middlewareContext.currentState = &_eventHandler->state();
    
    if (_middlewareChain.size() > 0) {
        Logger::infof("Processing request through ", _middlewareChain.size(), " middlewares");
        input = _middlewareChain.processRequest(input, middlewareContext);
        
        // Check if should continue
        if (!middlewareContext.shouldContinue) {
            Logger::info("Middleware stopped execution");
            if (onError) {
                onError("Middleware stopped execution");
            }
            return;
        }
    }

    // 3. Add subscribers from params to EventHandler
    for (auto& subscriber : params.subscribers) {
        _eventHandler->addSubscriber(subscriber);
    }
    Logger::debugf("Total subscribers: ", params.subscribers.size());

    // 4. Build HTTP request
    HttpRequest request;
    request.url = _baseUrl;
    request.method = HttpMethod::POST;
    request.headers = _headers;
    request.body = input.toJson().dump();

    Logger::debugf("Sending request to ", _baseUrl);
    Logger::debugf("Request body size: ", request.body.size(), " bytes");

    // 5. Send request with separated onData and onComplete handlers
    _httpService->sendSseRequest(
        request,
        // onData: Incremental processing of SSE chunks
        [this](const HttpResponse& response) {
            this->handleStreamData(response);
        },
        // onComplete: Final processing when stream ends
        [this, onSuccess, onError](const HttpResponse& response) {
            this->handleStreamComplete(response, onSuccess, onError);
        },
        [onError](const AgentError& error) {
            onError(error.fullMessage());
        });
}

void HttpAgent::handleStreamData(const HttpResponse& response) {
    // Feed data incrementally without clearing parser
    _sseParser->feed(response.content);
    
    // Process all complete events available
    processAvailableEvents();
}

void HttpAgent::processAvailableEvents() {
    // Prepare middleware context
    MiddlewareContext middlewareContext(nullptr, nullptr);
    middlewareContext.currentMessages = &_eventHandler->messages();
    middlewareContext.currentState = &_eventHandler->state();

    // Process all available SSE events
    while (_sseParser->hasEvent()) {
        try {
            const std::string &eventData = _sseParser->nextEvent();
            if (eventData.empty()) {
                continue;
            }
            nlohmann::json eventJson = nlohmann::json::parse(eventData);
            // Parse as Event object
            std::unique_ptr<Event> event(EventParser::parse(eventJson));

            if (!event) {
                continue;
            }
            // Process event through middleware
            if (_middlewareChain.size() > 0) {
                auto processedEvents = _middlewareChain.processEvent(std::move(event), middlewareContext);
                
                // Process all returned events
                for (auto& processedEvent : processedEvents) {
                    AgentStateMutation mutation = _eventHandler->handleEvent(std::move(processedEvent));
                    if (mutation.hasChanges()) {
                        _eventHandler->applyMutation(mutation);
                        // Update middleware context
                        middlewareContext.currentMessages = &_eventHandler->messages();
                        middlewareContext.currentState = &_eventHandler->state();
                    }
                }
            } else {
                // No middleware, process directly
                AgentStateMutation mutation = _eventHandler->handleEvent(std::move(event));
                if (mutation.hasChanges()) {
                    _eventHandler->applyMutation(mutation);
                }
            }
        } catch (const std::exception& e) {
            Logger::errorf("Error processing event: ", e.what());
            
            // Call user's error callback if available
            if (_currentErrorCallback) {
                AgentError error(ErrorType::Parse, ErrorCode::ParseEventError, e.what());
                _currentErrorCallback(error.fullMessage());
            }
            
            // Stop processing further events after error
            break;
        }
    }

    // Check for parsing errors
    if (!_sseParser->getLastError().empty()) {
        Logger::warningf("SSE parser error: ", _sseParser->getLastError());
    }
}

void HttpAgent::handleStreamComplete(const HttpResponse& response, AgentSuccessCallback onSuccess,
                                     AgentErrorCallback onError) {
    // Check if HTTP request succeeded
    if (!response.isSuccess()) {
        Logger::errorf("HTTP request failed with status: ", response.statusCode);
        if (onError) {
            onError("HTTP request failed with status: " + std::to_string(response.statusCode));
        }
        return;
    }

    Logger::info("Stream complete, flushing remaining data");

    // Flush any remaining data in parser buffer
    _sseParser->flush();
    
    // Process any remaining events
    processAvailableEvents();

    // Collect results
    RunAgentResult result;
    result.newState = _eventHandler->state();
    result.result = _eventHandler->result();
    result.threadId = "";

    // All messages are new messages (no need to track initial IDs in streaming mode)
    result.newMessages = _eventHandler->messages();

    // Process response through middleware
    if (_middlewareChain.size() > 0) {
        Logger::infof("Processing response through ", _middlewareChain.size(), " middlewares");
        MiddlewareContext middlewareContext(nullptr, nullptr);
        middlewareContext.currentMessages = &_eventHandler->messages();
        middlewareContext.currentState = &_eventHandler->state();
        result = _middlewareChain.processResponse(result, middlewareContext);
    }

    // Call success callback
    if (onSuccess) {
        onSuccess(result);
    }
}

}  // namespace agui
