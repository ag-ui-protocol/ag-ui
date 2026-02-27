#include <iostream>
#include <memory>
#include <string>

#include "agent/http_agent.h"
#include "middleware/middleware.h"
#include "core/event.h"

using namespace agui;
using namespace std;

// Test Middleware implementations

/**
 * @brief Request modifier middleware
 */
class RequestModifierMiddleware : public IMiddleware {
public:
    RunAgentInput onRequest(const RunAgentInput& input, MiddlewareContext& context) override {
        cout << "[TEST] RequestModifierMiddleware: Modifying request" << endl;
        
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
        cout << "[TEST] ResponseModifierMiddleware: Modifying response" << endl;
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
            cout << "[TEST] EventFilterMiddleware: Filtering event type "
                 << static_cast<int>(_filterType) << endl;
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
        cout << "[TEST] LoggingTestMiddleware: Request #" << requestCount << endl;
        return input;
    }
    
    RunAgentResult onResponse(const RunAgentResult& result, MiddlewareContext& context) override {
        responseCount++;
        cout << "[TEST] LoggingTestMiddleware: Response #" << responseCount << endl;
        return result;
    }
    
    std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override {
        eventCount++;
        cout << "[TEST] LoggingTestMiddleware: Event #" << eventCount
             << " (type=" << static_cast<int>(event->type()) << ")" << endl;
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
            cout << "[TEST] ExecutionControlMiddleware: Stopping execution" << endl;
            context.shouldContinue = false;
            return false;
        }
        return true;
    }
    
private:
    bool _shouldStop;
};

// Test helper functions

void printTestHeader(const string& testName) {
    cout << "\n========================================" << endl;
    cout << "Test: " << testName << endl;
    cout << "========================================" << endl;
}

void printTestResult(const string& testName, bool passed) {
    if (passed) {
        cout << " " << testName << " - Passed" << endl;
    } else {
        cout << " " << testName << " - Failed" << endl;
    }
}

// Test cases
const std::string MOCK_SERVER_URL = "http://localhost:8080/api/agent/run";

void test_add_single_middleware() {
    printTestHeader("Add single middleware");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .withAgentId("test-agent")
        .build();
    
    auto middleware = make_shared<LoggingTestMiddleware>();
    agent->use(middleware);
    
    bool passed = (agent->middlewareChain().size() == 1);
    printTestResult("Add single middleware", passed);
    
    cout << "Middleware count: " << agent->middlewareChain().size() << endl;
}

void test_add_multiple_middlewares() {
    printTestHeader("Add multiple middlewares");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto middleware1 = make_shared<LoggingTestMiddleware>();
    auto middleware2 = make_shared<RequestModifierMiddleware>();
    auto middleware3 = make_shared<ResponseModifierMiddleware>();
    
    agent->use(middleware1)
          .use(middleware2)
          .use(middleware3);
    
    bool passed = (agent->middlewareChain().size() == 3);
    printTestResult("Add multiple middlewares", passed);
    
    cout << "Middleware count: " << agent->middlewareChain().size() << endl;
}

void test_request_modification() {
    printTestHeader("Request modification test");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto requestMod = make_shared<RequestModifierMiddleware>();
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
    
    bool passed = hasContext && hasMetadata;
    printTestResult("Request modification", passed);
    cout << "Context added: " << (hasContext ? "Yes" : "No") << endl;
    cout << "Metadata set: " << (hasMetadata ? "Yes" : "No") << endl;
}

void test_response_modification() {
    printTestHeader("Response modification test");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto responseMod = make_shared<ResponseModifierMiddleware>();
    agent->use(responseMod);
    
    RunAgentResult result;
    result.result = "response content";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext context(nullptr, &result);
    
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, context);
    
    bool hasMetadata = (context.metadata["response_modified"] == "true");
    
    bool passed = hasMetadata;
    printTestResult("Response modification", passed);
    cout << "Metadata set: " << (hasMetadata ? "Yes" : "No") << endl;
}

void test_multiple_middlewares_chain() {
    printTestHeader("Multiple middleware chain test");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto logging = make_shared<LoggingTestMiddleware>();
    auto requestMod = make_shared<RequestModifierMiddleware>();
    auto responseMod = make_shared<ResponseModifierMiddleware>();
    
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
    
    bool requestPassed = (logging->requestCount == 1);
    
    RunAgentResult result;
    result.result = "agent result";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext responseContext(nullptr, &result);
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, responseContext);
    
    bool responsePassed = (logging->responseCount == 1);
    
    bool passed = requestPassed && responsePassed;
    printTestResult("Multiple middleware chain", passed);
    
    cout << "Logging request count: " << logging->requestCount << endl;
    cout << "Logging response count: " << logging->responseCount << endl;
}

void test_event_filtering() {
    printTestHeader("Event filtering test");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto eventFilter = make_shared<EventFilterMiddleware>(EventType::RunStarted);
    agent->use(eventFilter);
    
    auto event1 = make_unique<RunStartedEvent>();
    MiddlewareContext context1(nullptr, nullptr);
    auto processedEvents1 = agent->middlewareChain().processEvent(std::move(event1), context1);
    
    bool filtered = processedEvents1.empty();
    
    auto event2 = make_unique<RunFinishedEvent>();
    MiddlewareContext context2(nullptr, nullptr);
    auto processedEvents2 = agent->middlewareChain().processEvent(std::move(event2), context2);
    
    bool notFiltered = (processedEvents2.size() == 1);
    
    bool passed = filtered && notFiltered;
    printTestResult("Event filtering", passed);
    
    cout << "RUN_STARTED filtered: " << (filtered ? "Yes" : "No") << endl;
    cout << "RUN_FINISHED not filtered: " << (notFiltered ? "Yes" : "No") << endl;
}

void test_execution_control() {
    printTestHeader("Execution control test");
    
    {
        auto agent = HttpAgent::builder()
            .withUrl(MOCK_SERVER_URL)
            .build();
        
        auto execControl = make_shared<ExecutionControlMiddleware>(false);
        agent->use(execControl);
        
        RunAgentInput input;
        MiddlewareContext context(&input, nullptr);
        agent->middlewareChain().processRequest(input, context);
        
        bool continuePassed = context.shouldContinue;
        cout << "Allow continue execution: " << (continuePassed ? "Yes" : "No") << endl;
    }
    
    {
        auto agent = HttpAgent::builder()
            .withUrl(MOCK_SERVER_URL)
            .build();
        
        auto execControl = make_shared<ExecutionControlMiddleware>(true);
        agent->use(execControl);
        
        RunAgentInput input;
        MiddlewareContext context(&input, nullptr);
        agent->middlewareChain().processRequest(input, context);
        
        bool stopPassed = !context.shouldContinue;
        cout << "Stop execution: " << (stopPassed ? "Yes" : "No") << endl;
        
        printTestResult("Execution control", stopPassed);
    }
}

void test_complex_middleware_chain() {
    printTestHeader("Complex middleware chain test");
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .build();
    
    auto logging = make_shared<LoggingTestMiddleware>();
    auto requestMod = make_shared<RequestModifierMiddleware>();
    auto eventFilter = make_shared<EventFilterMiddleware>(EventType::RunStarted);
    auto responseMod = make_shared<ResponseModifierMiddleware>();
    
    agent->use(logging)
          .use(requestMod)
          .use(eventFilter)
          .use(responseMod);
    
    cout << "Middleware chain size: " << agent->middlewareChain().size() << endl;
    
    RunAgentInput input;
    input.threadId = "test-thread";
    input.runId = "test-run";
    input.messages = {};
    input.state = "current state";
    
    MiddlewareContext requestContext(&input, nullptr);
    RunAgentInput modifiedInput = agent->middlewareChain().processRequest(input, requestContext);
    cout << "Logging request count: " << logging->requestCount << endl;
    
    auto event1 = make_unique<RunStartedEvent>();
    MiddlewareContext eventContext1(nullptr, nullptr);
    auto processedEvents1 = agent->middlewareChain().processEvent(std::move(event1), eventContext1);
    
    bool event1Filtered = processedEvents1.empty();
    cout << "RUN_STARTED filtered: " << (event1Filtered ? "Yes" : "No") << endl;
    
    auto event2 = make_unique<RunFinishedEvent>();
    MiddlewareContext eventContext2(nullptr, nullptr);
    auto processedEvents2 = agent->middlewareChain().processEvent(std::move(event2), eventContext2);
    
    bool event2NotFiltered = (processedEvents2.size() == 1);
    cout << "RUN_FINISHED not filtered: " << (event2NotFiltered ? "Yes" : "No") << endl;
    cout << "Logging event count: " << logging->eventCount << endl;
    
    RunAgentResult result;
    result.result = "agent result";
    result.newState = "new state";
    result.newMessages = {};
    
    MiddlewareContext responseContext(nullptr, &result);
    RunAgentResult modifiedResult = agent->middlewareChain().processResponse(result, responseContext);
    cout << "Logging response count: " << logging->responseCount << endl;
    
    bool passed = event1Filtered && event2NotFiltered;
    printTestResult("Complex middleware chain", passed);
}

void test_real_http_request_with_middleware() {
    printTestHeader("Real HTTP request + Middleware test");
    
    cout << "If server is not running, this test will fail" << endl;
    cout << endl;
    
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL)
        .withAgentId("test-agent-with-middleware")
        .build();
    
    auto logging = make_shared<LoggingTestMiddleware>();
    auto requestMod = make_shared<RequestModifierMiddleware>();
    auto responseMod = make_shared<ResponseModifierMiddleware>();
    
    agent->use(logging)
          .use(requestMod)
          .use(responseMod);
    
    cout << "Added " << agent->middlewareChain().size() << " middlewares" << endl;
    cout << "Starting HTTP request..." << endl;
    
    RunAgentParams params;
    params.threadId = "test-thread-123";
    params.runId = "test-run-456";
    
    Message userMsg;
    userMsg.setRole(MessageRole::User);
    userMsg.setContent("Hello, this is a test message with middleware!");
    agent->addMessage(userMsg);
    
    bool testCompleted = false;
    bool testPassed = false;
    
    agent->runAgent(
        params,
        [&](const RunAgentResult& result) {
            cout << "\n HTTP request successful!" << endl;
            cout << "Received " << result.newMessages.size() << " new messages" << endl;
            
            cout << "\nMiddleware call statistics:" << endl;
            cout << "- Request processing count: " << logging->requestCount << endl;
            cout << "- Response processing count: " << logging->responseCount << endl;
            cout << "- Event processing count: " << logging->eventCount << endl;
            
            cout << "\nResult details:" << endl;
            cout << "- Thread ID: " << result.threadId << endl;
            cout << "- New message count: " << result.newMessages.size() << endl;
            cout << "- Result: " << result.result << endl;
            
            testCompleted = true;
            testPassed = true;
        },
        [&](const string& error) {
            cout << "\n HTTP request failed: " << error << endl;
            cout << "\nPossible reasons:" << endl;
            cout << "1. AG-UI server not running" << endl;
            cout << "2. Server address incorrect" << endl;
            cout << "3. Network connection issue" << endl;
            
            testCompleted = true;
            testPassed = false;
        }
    );
    
    cout << "\nWaiting for HTTP response..." << endl;
    int waitCount = 0;
    while (!testCompleted && waitCount < 100) {
        for (int i = 0; i < 100000000; i++) {
            // Empty loop for delay
        }
        waitCount++;
        if (waitCount % 10 == 0) {
            cout << "." << flush;
        }
    }
    cout << endl;
    
    if (!testCompleted) {
        cout << "\n  Request timeout (10 seconds)" << endl;
        testPassed = false;
    }
    
    printTestResult("Real HTTP request + Middleware", testPassed);
}

int main(int argc, char** argv) {
    cout << "\n" << endl;
    cout << "========================================" << endl;
    cout << "  HttpAgent Middleware Test Suite" << endl;
    cout << "========================================" << endl;
    
    cout << "\n========================================" << endl;
    cout << "  Unit Tests (no server required)" << endl;
    cout << "========================================" << endl;
    
    test_add_single_middleware();
    test_add_multiple_middlewares();
    test_request_modification();
    test_response_modification();
    test_multiple_middlewares_chain();
    test_event_filtering();
    test_execution_control();
    test_complex_middleware_chain();
    
    test_real_http_request_with_middleware();
    
    cout << "\n========================================" << endl;
    cout << "All tests completed!" << endl;
    cout << "========================================\n" << endl;
    
    return 0;
}
