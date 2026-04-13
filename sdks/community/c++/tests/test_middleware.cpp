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
        : m_filterType(filterType) {}
    
    bool shouldProcessEvent(const Event& event, MiddlewareContext& context) override {
        if (event.type() == m_filterType) {
            return false;
        }
        return true;
    }
    
private:
    EventType m_filterType;
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
        : m_shouldStop(shouldStop) {}
    
    bool shouldContinue(const RunAgentInput& input, MiddlewareContext& context) override {
        if (m_shouldStop) {
            context.shouldContinue = false;
            return false;
        }
        return true;
    }
    
private:
    bool m_shouldStop;
};

class AfterEventMiddleware : public IMiddleware {
public:
    std::vector<std::unique_ptr<Event>> afterEvent(const Event& event, MiddlewareContext& context) override {
        (void)context;
        std::vector<std::unique_ptr<Event>> events;
        auto after = std::make_unique<StepFinishedEvent>();
        after->stepName = "after";
        events.push_back(std::move(after));
        return events;
    }
};

class ThrowingEventMiddleware : public IMiddleware {
public:
    std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override {
        (void)event;
        (void)context;
        throw std::runtime_error("middleware event failure");
    }
};

class ThrowingRequestMiddleware : public IMiddleware {
public:
    RunAgentInput onRequest(const RunAgentInput&, MiddlewareContext&) override {
        throw std::runtime_error("request middleware failure");
    }
};

class ThrowingShouldContinueMiddleware : public IMiddleware {
public:
    bool shouldContinue(const RunAgentInput&, MiddlewareContext&) override {
        throw std::runtime_error("shouldContinue failure");
    }
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
    input.state = {{"initialized", true}};

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
    result.newState = {{"updated", true}};
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
    input.state = {{"current", true}};

    MiddlewareContext requestContext(&input, nullptr);
    RunAgentInput modifiedInput = agent->middlewareChain().processRequest(input, requestContext);

    EXPECT_EQ(logging->requestCount, 1);

    RunAgentResult result;
    result.result = "agent result";
    result.newState = {{"updated", true}};
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

TEST(MiddlewareTest, AfterEventIsPlacedAfterProcessedEvent) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();

    auto afterMiddleware = std::make_shared<AfterEventMiddleware>();
    agent->use(afterMiddleware);

    auto event = std::make_unique<RunFinishedEvent>();
    MiddlewareContext context(nullptr, nullptr);
    auto processedEvents = agent->middlewareChain().processEvent(std::move(event), context);

    ASSERT_EQ(processedEvents.size(), 2);
    EXPECT_EQ(processedEvents[0]->type(), EventType::RunFinished);
    EXPECT_EQ(processedEvents[1]->type(), EventType::StepFinished);
}

TEST(MiddlewareTest, EventMiddlewareExceptionPropagatesToCaller) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();

    auto throwingMiddleware = std::make_shared<ThrowingEventMiddleware>();
    agent->use(throwingMiddleware);

    auto event = std::make_unique<RunFinishedEvent>();
    MiddlewareContext context(nullptr, nullptr);

    EXPECT_THROW(agent->middlewareChain().processEvent(std::move(event), context), std::runtime_error);
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

TEST(MiddlewareTest, RequestMiddlewareExceptionPropagatesToCaller) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();

    agent->use(std::make_shared<ThrowingRequestMiddleware>());

    RunAgentInput input;
    MiddlewareContext context(&input, nullptr);

    EXPECT_THROW(agent->middlewareChain().processRequest(input, context), std::runtime_error);
    EXPECT_TRUE(context.shouldContinue);
}

TEST(MiddlewareTest, ShouldContinueExceptionPropagatesToCaller) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();

    agent->use(std::make_shared<ThrowingShouldContinueMiddleware>());

    RunAgentInput input;
    MiddlewareContext context(&input, nullptr);

    EXPECT_THROW(agent->middlewareChain().processRequest(input, context), std::runtime_error);
    EXPECT_TRUE(context.shouldContinue);
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
    input.state = {{"current", true}};

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
    result.newState = {{"updated", true}};
    result.newMessages = {};
    
    MiddlewareContext responseContext(nullptr, &result);
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, responseContext);
    EXPECT_EQ(logging->responseCount, 1);
}

// ── TH-3: Builder::build() rejects an empty URL ──────────────────────────────
TEST(HttpAgentBuilderTest, BuildThrowsOnEmptyUrl) {
    EXPECT_THROW(
        HttpAgent::builder().build(),
        AgentError
    );
}

// ── TH-4: MiddlewareChain::notifyError notifies all middlewares ───────────────
class ErrorCapturingMiddleware : public IMiddleware {
public:
    int errorCount = 0;
    std::string lastErrorMessage;

    std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error,
                                        MiddlewareContext& context) override {
        errorCount++;
        if (error) {
            lastErrorMessage = error->message();
        }
        return error;
    }
};

class ThrowingErrorMiddleware : public IMiddleware {
public:
    std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error,
                                        MiddlewareContext& context) override {
        throw std::runtime_error("middleware error notification failure");
    }
};

TEST(MiddlewareChainTest, NotifyErrorReachesAllMiddlewaresEvenIfOneFails) {
    MiddlewareChain chain;
    auto catcher1 = std::make_shared<ErrorCapturingMiddleware>();
    auto thrower  = std::make_shared<ThrowingErrorMiddleware>();
    auto catcher2 = std::make_shared<ErrorCapturingMiddleware>();

    chain.addMiddleware(catcher1);
    chain.addMiddleware(thrower);
    chain.addMiddleware(catcher2);

    AgentError err(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, "test error");
    RunAgentInput input;
    MiddlewareContext ctx(&input, nullptr);

    // notifyError must not throw and must notify all middlewares in reverse order
    EXPECT_NO_THROW(chain.notifyError(err, ctx));

    // Both catchers should have been called (thrower is between them in reverse order)
    EXPECT_EQ(catcher1->errorCount, 1);
    EXPECT_EQ(catcher2->errorCount, 1);
    EXPECT_EQ(catcher1->lastErrorMessage, "test error");
}
