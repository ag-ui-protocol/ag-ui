#include <gtest/gtest.h>
#include <iostream>
#include <memory>
#include <string>

#include "agent/http_agent.h"
#include "middleware/middleware.h"
#include "core/event.h"

using namespace agui;
// Test Middleware implementations

/**
 * @brief Request modifier middleware
 */
class RequestModifierMiddleware : public IMiddleware {
public:
    RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) override {
        RunAgentInput modifiedInput = input;
        modifiedInput.context.push_back(Context());
        
        context.metadata["request_modified"] = "true";
        
        return modifiedInput;
    }
};

/**
 * @brief Response modifier middleware
 */
class ResponseModifierMiddleware : public IMiddleware {
public:
    RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) override {
        RunAgentResult modifiedResult = result;
        modifiedResult.result = "modified content";
        context.metadata["response_modified"] = "true";
        
        return modifiedResult;
    }
};

/**
 * @brief Event filter middleware
 */
class EventFilterMiddleware : public IMiddleware {
public:
    explicit EventFilterMiddleware(EventType filterType)
        : _filterType(filterType) {}
    
    bool shouldProcessEvent(const Event& event, MiddlewareContext& context) override {
        if (event.type() == _filterType) {
            return false;
        }
        return true;
    }
    
private:
    EventType _filterType;
};

/**
 * @brief Logging middleware
 */
class LoggingTestMiddleware : public IMiddleware {
public:
    LoggingTestMiddleware() : requestCount(0), responseCount(0), eventCount(0) {}
    
    RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) override {
        requestCount++;
        std::cout << "[TEST] LoggingTestMiddleware: Request #" << requestCount << std::endl;
        return input;
    }
    
    RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) override {
        responseCount++;
        std::cout << "[TEST] LoggingTestMiddleware: Response #" << responseCount << std::endl;
        return result;
    }
    
    std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override {
        eventCount++;
        std::cout << "[TEST] LoggingTestMiddleware: Event #" << eventCount
             << " (type=" << static_cast<int>(event->type()) << ")" << std::endl;
        return event;
    }
    
    int requestCount;
    int responseCount;
    int eventCount;
};

/**
 * @brief Execution control middleware
 */
class ExecutionControlMiddleware : public IMiddleware {
public:
    explicit ExecutionControlMiddleware(bool shouldStop)
        : _shouldStop(shouldStop) {}
    
    bool shouldContinue(const RunAgentInput& input, MiddlewareContext& context) override {
        if (_shouldStop) {
            context.shouldContinue = false;
            return false;
        }
        return true;
    }
    
private:
    bool _shouldStop;
};

// Test cases
const std::string MOCK_SERVER_URL = "http://localhost:8080/api/agent/run";

// Middleware Management Tests
TEST(MiddlewareTest, AddSingleMiddleware) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .withAgentId("test-agent")
        .build();
    
    auto middleware = std::make_shared<LoggingTestMiddleware>();
    agent->use(middleware);
    
    EXPECT_EQ(agent->middlewareChain().size(), 1);
}

TEST(MiddlewareTest, AddMultipleMiddlewares) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto middleware1 = std::make_shared<LoggingTestMiddleware>();
    auto middleware2 = std::make_shared<RequestModifierMiddleware>();
    auto middleware3 = std::make_shared<ResponseModifierMiddleware>();
    
    agent->use(middleware1)
          .use(middleware2)
          .use(middleware3);
    
    EXPECT_EQ(agent->middlewareChain().size(), 3);
}

// Request/Response Modification Tests
TEST(MiddlewareTest, RequestModification) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto requestMod = std::make_shared<RequestModifierMiddleware>();
    agent->use(requestMod);
    
    RunAgentInput input;
    input.threadId = "test-thread";
    input.runId = "test-run";
    input.messages = {};
    input.state = "initialize state";
    
    MiddlewareContext context(&input, nullptr);
    
    RunAgentInput modifiedInput = agent->middlewareChain().processRequest(input, context);
    
    bool hasContext = !modifiedInput.context.empty();
    bool hasMetadata = (context.metadata["request_modified"] == "true");
    
    EXPECT_TRUE(hasContext);
    EXPECT_TRUE(hasMetadata);
}

TEST(MiddlewareTest, ResponseModification) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto responseMod = std::make_shared<ResponseModifierMiddleware>();
    agent->use(responseMod);
    
    RunAgentResult result;
    result.result = "response content";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext context(nullptr, &result);
    
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, context);
    
    bool hasMetadata = (context.metadata["response_modified"] == "true");
    EXPECT_TRUE(hasMetadata);
    EXPECT_EQ(modifiedResult.result, "modified content");
}

TEST(MiddlewareTest, MultipleMiddlewaresChain) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto logging = std::make_shared<LoggingTestMiddleware>();
    auto requestMod = std::make_shared<RequestModifierMiddleware>();
    auto responseMod = std::make_shared<ResponseModifierMiddleware>();
    
    agent->use(logging)
          .use(requestMod)
          .use(responseMod);
    
    RunAgentInput input;
    input.threadId = "test-thread";
    input.runId = "test-run";
    input.messages = {};
    input.state = "current state";
    
    MiddlewareContext requestContext(&input, nullptr);
    RunAgentInput modifiedInput = agent->middlewareChain().processRequest(input, requestContext);
    
    EXPECT_EQ(logging->requestCount, 1);
    
    RunAgentResult result;
    result.result = "agent result";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext responseContext(nullptr, &result);
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, responseContext);
    
    EXPECT_EQ(logging->responseCount, 1);
}

// Event Filtering Tests
TEST(MiddlewareTest, EventFiltering) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto eventFilter = std::make_shared<EventFilterMiddleware>(EventType::RunStarted);
    agent->use(eventFilter);
    
    auto event1 = std::make_unique<RunStartedEvent>();
    MiddlewareContext context1(nullptr, nullptr);
    auto processedEvents1 = agent->middlewareChain().processEvent(std::move(event1), context1);
    
    EXPECT_TRUE(processedEvents1.empty());
    
    auto event2 = std::make_unique<RunFinishedEvent>();
    MiddlewareContext context2(nullptr, nullptr);
    auto processedEvents2 = agent->middlewareChain().processEvent(std::move(event2), context2);
    
    EXPECT_EQ(processedEvents2.size(), 1);
}

// Execution Control Tests
TEST(MiddlewareTest, ExecutionControlAllow) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto execControl = std::make_shared<ExecutionControlMiddleware>(false);
    agent->use(execControl);
    
    RunAgentInput input;
    MiddlewareContext context(&input, nullptr);
    agent->middlewareChain().processRequest(input, context);
    
    EXPECT_TRUE(context.shouldContinue);
}

TEST(MiddlewareTest, ExecutionControlStop) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto execControl = std::make_shared<ExecutionControlMiddleware>(true);
    agent->use(execControl);
    
    RunAgentInput input;
    MiddlewareContext context(&input, nullptr);
    agent->middlewareChain().processRequest(input, context);
    
    EXPECT_FALSE(context.shouldContinue);
}

// Complex Middleware Chain Tests
TEST(MiddlewareTest, ComplexMiddlewareChain) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto logging = std::make_shared<LoggingTestMiddleware>();
    auto requestMod = std::make_shared<RequestModifierMiddleware>();
    auto eventFilter = std::make_shared<EventFilterMiddleware>(EventType::RunStarted);
    auto responseMod = std::make_shared<ResponseModifierMiddleware>();
    
    agent->use(logging)
          .use(requestMod)
          .use(eventFilter)
          .use(responseMod);
    
    EXPECT_EQ(agent->middlewareChain().size(), 4);
    
    RunAgentInput input;
    input.threadId = "test-thread";
    input.runId = "test-run";
    input.messages = {};
    input.state = "current state";
    
    MiddlewareContext requestContext(&input, nullptr);
    RunAgentInput modifiedInput = agent->middlewareChain().processRequest(input, requestContext);
    EXPECT_EQ(logging->requestCount, 1);
    
    auto event1 = std::make_unique<RunStartedEvent>();
    MiddlewareContext eventContext1(nullptr, nullptr);
    auto processedEvents1 = agent->middlewareChain().processEvent(std::move(event1), eventContext1);
    
    EXPECT_TRUE(processedEvents1.empty());
    
    auto event2 = std::make_unique<RunFinishedEvent>();
    MiddlewareContext eventContext2(nullptr, nullptr);
    auto processedEvents2 = agent->middlewareChain().processEvent(std::move(event2), eventContext2);
    
    EXPECT_EQ(processedEvents2.size(), 1);
    
    RunAgentResult result;
    result.result = "agent result";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext responseContext(nullptr, &result);
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, responseContext);
    EXPECT_EQ(logging->responseCount, 1);
}
