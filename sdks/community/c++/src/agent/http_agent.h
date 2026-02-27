#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include "agent.h"
#include "core/event.h"
#include "core/session_types.h"
#include "core/subscriber.h"
#include "http/http_service.h"
#include "stream/sse_parser.h"
#include "middleware/middleware.h"

#include <nlohmann/json.hpp>

namespace agui {

/**
 * @brief HTTP Agent implementation for communicating with Agent server via HTTP/SSE
 */
class HttpAgent : public IAgent {
public:
    /**
     * @brief Builder class for constructing HttpAgent using Builder pattern
     */
    class Builder {
    public:
        Builder();

        /**
         * @brief Set base URL
         * @param url Base URL
         * @return Builder reference
         */
        Builder& withUrl(const std::string& url);

        /**
         * @brief Add HTTP header
         * @param name Header name
         * @param value Header value
         * @return Builder reference
         */
        Builder& withHeader(const std::string& name, const std::string& value);

        /**
         * @brief Set Bearer token
         * @param token Token value
         * @return Builder reference
         */
        Builder& withBearerToken(const std::string& token);

        /**
         * @brief Set timeout
         * @param seconds Timeout in seconds
         * @return Builder reference
         */
        Builder& withTimeout(uint32_t seconds);

        /**
         * @brief Set Agent ID
         * @param id Agent ID
         * @return Builder reference
         */
        Builder& withAgentId(const AgentId& id);

        /**
         * @brief Set initial messages
         * @param messages Initial message list
         * @return Builder reference
         */
        Builder& withInitialMessages(const std::vector<Message>& messages);

        /**
         * @brief Set initial state
         * @param state Initial state
         * @return Builder reference
         */
        Builder& withInitialState(const nlohmann::json& state);

        /**
         * @brief Build HttpAgent
         * @return HttpAgent smart pointer
         */
        std::unique_ptr<HttpAgent> build();

    private:
        std::string _url;
        std::map<std::string, std::string> _headers;
        uint32_t _timeout;
        AgentId _agentId;
        std::vector<Message> _initialMessages;
        std::string _initialState;
    };

    /**
     * @brief Create Builder
     * @return Builder object
     */
    static Builder builder();

    /**
     * @brief Destructor
     */
    virtual ~HttpAgent();

    // IAgent interface implementation
    void runAgent(const RunAgentParams& params, AgentSuccessCallback onSuccess, AgentErrorCallback onError) override;

    AgentId agentId() const override;

    // State access (delegated to EventHandler)

    /**
     * @brief Get messages
     * @return Const reference to message list
     */
    const std::vector<Message>& messages() const;

    /**
     * @brief Get state
     * @return Const reference to state
     */
    const std::string& state() const;

    // State modification (delegated to EventHandler)

    /**
     * @brief Add message
     * @param message Message to add
     */
    void addMessage(const Message& message);

    /**
     * @brief Set messages
     * @param messages New message list
     */
    void setMessages(const std::vector<Message>& messages);

    /**
     * @brief Set state
     * @param state New state
     */
    void setState(const nlohmann::json& state);

    // Subscriber management (delegated to EventHandler)

    /**
     * @brief Add subscriber
     * @param subscriber Subscriber smart pointer
     */
    void subscribe(std::shared_ptr<IAgentSubscriber> subscriber);

    /**
     * @brief Remove subscriber
     * @param subscriber Subscriber smart pointer
     */
    void unsubscribe(std::shared_ptr<IAgentSubscriber> subscriber);

    /**
     * @brief Clear all subscribers
     */
    void clearSubscribers();

    // Middleware management

    /**
     * @brief Add middleware
     * @param middleware Middleware smart pointer
     * @return HttpAgent reference for chaining
     */
    HttpAgent& use(std::shared_ptr<IMiddleware> middleware);

    /**
     * @brief Get middleware chain
     * @return Reference to middleware chain
     */
    MiddlewareChain& middlewareChain();

private:
    /**
     * @brief Constructor (private)
     */
    HttpAgent(const std::string& baseUrl, const std::map<std::string, std::string>& headers, const AgentId& agentId,
              const std::vector<Message>& initialMessages, const std::string& initialState);

    /**
     * @brief Handle HTTP response
     */
    void handleResponse(const HttpResponse& response, AgentSuccessCallback onSuccess, AgentErrorCallback onError);

    std::string _baseUrl;
    std::map<std::string, std::string> _headers;
    AgentId _agentId;

    // Persistent EventHandler
    std::shared_ptr<EventHandler> _eventHandler;

    std::unique_ptr<HttpService> _httpService;
    std::unique_ptr<SseParser> _sseParser;
    
    // Middleware chain
    MiddlewareChain _middlewareChain;
};

}  // namespace agui
