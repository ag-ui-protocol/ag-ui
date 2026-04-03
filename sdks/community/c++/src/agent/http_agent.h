#pragma once

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "agent.h"
#include "core/event.h"
#include "core/event_verifier.h"
#include "core/session_types.h"
#include "core/subscriber.h"
#include "http/http_service.h"
#include "stream/sse_parser.h"
#include "middleware/middleware.h"

#include <nlohmann/json.hpp>

namespace agui {

class HttpAgent : public IAgent {
public:
    class Builder {
    public:
        // Token struct: private constructor means only Builder (friend) can instantiate it,
        // restricting HttpAgent construction to Builder::build() while allowing std::make_unique.
        struct ConstructorAccess {
        private:
            explicit ConstructorAccess() = default;
            friend class Builder;
        };

        Builder();

        Builder& withUrl(const std::string& url);
        Builder& withHeader(const std::string& name, const std::string& value);
        Builder& withBearerToken(const std::string& token);
        Builder& withTimeout(uint32_t seconds);
        Builder& withAgentId(const AgentId& id);
        Builder& withInitialMessages(const std::vector<Message>& messages);
        Builder& withInitialState(const nlohmann::json& state);
        std::unique_ptr<HttpAgent> build();

    private:
        std::string m_url;
        std::map<std::string, std::string> m_headers;
        uint32_t m_timeout;
        AgentId m_agentId;
        std::vector<Message> m_initialMessages;
        nlohmann::json m_initialState = nlohmann::json::object();
    };

    // Allow Builder class to access private constructor
    friend class Builder;

    static Builder builder();

    virtual ~HttpAgent();

    // IAgent interface implementation

    /**
     * @brief Run the agent with the given parameters
     *
     * @warning BLOCKING CALL - This method blocks the calling thread until completion
     *
     * This is a synchronous blocking call using libcurl. The blocking behavior is intentional
     * to provide maximum flexibility for different threading models (worker threads, thread pools,
     * async frameworks like Boost.Asio/Qt/libuv, etc.). See README.md "Architecture & Design Decisions"
     * section for detailed rationale and usage patterns.
     *
     * @param params Run parameters including input messages and state
     * @param onSuccess Callback invoked when agent completes successfully
     * @param onError Callback invoked when an error occurs
     */
    void runAgent(const RunAgentParams& params, AgentSuccessCallback onSuccess, AgentErrorCallback onError) override;

    AgentId agentId() const override;

    // State access and modification (delegated to EventHandler)
    const std::vector<Message>& messages() const;
    const nlohmann::json& state() const;
    void addMessage(const Message& message);
    void setMessages(const std::vector<Message>& messages);
    void setState(const nlohmann::json& state);

    // Subscriber management (delegated to EventHandler)
    void subscribe(std::shared_ptr<IAgentSubscriber> subscriber);
    void unsubscribe(std::shared_ptr<IAgentSubscriber> subscriber);
    void clearSubscribers();

    // Middleware management
    HttpAgent& use(std::shared_ptr<IMiddleware> middleware);
    MiddlewareChain& middlewareChain();

    /**
     * @brief Replace the HTTP service (dependency injection, useful for testing)
     * @param service Custom IHttpService implementation
     */
    void setHttpService(std::unique_ptr<IHttpService> service);

    /**
     * @brief Cancel the current agent run.
     *
     * Has no effect if no run is active.
     */
    void cancelRun();

public:
    // Public but effectively private: only Builder can construct ConstructorAccess.
    HttpAgent(Builder::ConstructorAccess,
              const std::string& baseUrl, const std::map<std::string, std::string>& headers, const AgentId& agentId,
              const std::vector<Message>& initialMessages, const nlohmann::json& initialState, uint32_t timeoutSeconds);

private:

    void handleStreamData(const HttpResponse& response);
    void handleStreamComplete(const HttpResponse& response, AgentSuccessCallback onSuccess, AgentErrorCallback onError);
    void processAvailableEvents();
    // Returns false when processing should stop (RunError detected).
    bool processNextEvent(MiddlewareContext& middlewareContext);
    RunAgentResult collectResults();
    void invokeErrorCallback(AgentErrorCallback onError, const std::string& errorMessage);
    // Called from all runAgent() exit paths to prevent per-run subscriber accumulation.
    void cleanupPerRunSubscribers();
    // Returns true if a RunError was detected (caller should break the event loop).
    bool processSingleEvent(std::unique_ptr<Event> event, MiddlewareContext& middlewareContext);
    // Returns nullptr if JSON parsing fails.
    std::unique_ptr<Event> parseSseEventData(const std::string& eventData);

    std::string m_baseUrl;
    std::map<std::string, std::string> m_headers;
    AgentId m_agentId;
    uint32_t m_timeoutSeconds;

    // Stored after middleware request processing so it can be passed as context.input
    // to MiddlewareContext during SSE streaming and response processing.
    RunAgentInput m_currentInput;

    std::shared_ptr<EventHandler> m_eventHandler;

    std::unique_ptr<IHttpService> m_httpService;
    std::unique_ptr<SseParser> m_sseParser;

    MiddlewareChain m_middlewareChain;

    // Per-run subscribers added via RunAgentParams; removed after each runAgent() call
    std::vector<std::shared_ptr<IAgentSubscriber>> m_perRunSubscribers;

    // Message IDs present before the run starts; used to compute the newMessages delta
    std::set<MessageId> m_preRunMessageIds;

    // Set to true when a RUN_ERROR event or a fatal event-processing error is
    // encountered during streaming
    bool m_runErrorOccurred = false;
    std::string m_runErrorMessage;
    // Preserves the original AgentError (type + code) for the terminal notifyRunFailed()
    // call when a streaming exception is caught.  std::nullopt when the error originated
    // from a non-AgentError source (network, STL, etc.).
    std::optional<AgentError> m_runError;
    EventVerifier m_eventVerifier;

    // Cancel key for the active request; used by cancelRun() to abort in-flight requests
    std::string m_currentRunKey;
};

}  // namespace agui
