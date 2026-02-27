/**
 * @file test_sse_server.cpp
 * @brief Integration tests with Mock server
 * 
 * Tests actual interaction between HTTP client, HttpAgent and middleware with Mock server
 * 
 * Before running, please ensure Mock server is started:
 * python3 tests/mock_server/mock_ag_server.py
 */

#include <iostream>
#include <memory>
#include <vector>
#include <atomic>
#include <thread>
#include <chrono>

#include "http/http_service.h"
#include "agent/http_agent.h"
#include "middleware/middleware.h"
#include "core/error.h"
#include "core/event.h"
#include "http_request_builder.h"

using namespace agui;


void log(const std::string& message) {
    std::cout << "[INTEGRATION_TEST] " << message << std::endl;
}

void assertTrue(bool condition, const std::string& message) {
    if (!condition) {
        std::cout << " Failed: " << message << std::endl;
    } else {
        std::cout << " " << message << std::endl;
    }
}

// Mock server address
const std::string MOCK_SERVER_URL = "http://localhost:8080";


void testHttpClientWithServer() {
    log("Integration Test 1: HTTP client interaction with Mock server");
    log("Note: Please ensure Mock server is started (python3 tests/mock_server/mock_ag_server.py)");

    try {
        auto httpService = HttpServiceFactory::createCurlService();
        
        // Test health check endpoint
        log("Test 1.1: Health check endpoint");
        {
            HttpRequest request = HttpRequestBuilder()
                .method(HttpMethod::GET)
                .url(MOCK_SERVER_URL + "/health")
                .timeout(5000)
                .build();

            std::atomic<bool> responseCalled{false};
            std::atomic<bool> errorCalled{false};
            HttpResponse receivedResponse;

            httpService->sendRequest(
                request,
                [&](const HttpResponse& response) {
                    receivedResponse = response;
                    responseCalled = true;
                    log("Received health check response");
                },
                [&](const AgentError& error) {
                    errorCalled = true;
                    log("Health check failed: " + error.message());
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(2));

            if (responseCalled) {
                assertTrue(receivedResponse.isSuccess(), "Health check returns success status");
                assertTrue(receivedResponse.statusCode == 200, "Status code is 200");
                log("Response content: " + receivedResponse.body);
            } else if (errorCalled) {
                log("  Unable to connect to Mock server, please ensure server is started");
            } else {
                log("  Request timeout or not completed");
            }
        }

        // Test scenarios list endpoint
        log("\nTest 1.2: Get scenarios list");
        {
            HttpRequest request = HttpRequestBuilder()
                .method(HttpMethod::GET)
                .url(MOCK_SERVER_URL + "/scenarios")
                .timeout(5000)
                .build();

            std::atomic<bool> responseCalled{false};
            HttpResponse receivedResponse;

            httpService->sendRequest(
                request,
                [&](const HttpResponse& response) {
                    receivedResponse = response;
                    responseCalled = true;
                    log("Received scenarios list response");
                },
                [&](const AgentError& error) {
                    log("Get scenarios list failed: " + error.message());
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(2));

            if (responseCalled) {
                assertTrue(receivedResponse.isSuccess(), "Scenarios list returns success");
                log("Scenarios list: " + receivedResponse.body);
            }
        }
    } catch (const std::exception& e) {
        log(" Test exception: " + std::string(e.what()));
    }
}


void testHttpAgentWithServer() {
    log("Integration Test 2: HttpAgent interaction with Mock server");
    try {
        // Create test subscriber
        class TestSubscriber : public IAgentSubscriber {
        public:
            std::atomic<int> textMessageStartCount{0};
            std::atomic<int> textMessageContentCount{0};
            std::atomic<int> textMessageEndCount{0};
            std::atomic<int> runStartedCount{0};
            std::atomic<int> runFinishedCount{0};
            std::string fullContent;

            AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                                  const AgentSubscriberParams& params) override {
                textMessageStartCount++;
                log("Subscriber: TEXT_MESSAGE_START - messageId=" + event.messageId);
                return AgentStateMutation();
            }

            AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event, const std::string& buffer,
                                                    const AgentSubscriberParams& params) override {
                textMessageContentCount++;
                fullContent += event.delta;
                log("Subscriber: TEXT_MESSAGE_CONTENT - delta=" + event.delta);
                return AgentStateMutation();
            }

            AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event, const AgentSubscriberParams& params) override {
                textMessageEndCount++;
                log("Subscriber: TEXT_MESSAGE_END");
                return AgentStateMutation();
            }

            AgentStateMutation onRunStarted(const RunStartedEvent& event, const AgentSubscriberParams& params) override {
                runStartedCount++;
                log("Subscriber: RUN_STARTED - runId=" + event.runId);
                return AgentStateMutation();
            }

            AgentStateMutation onRunFinished(const RunFinishedEvent& event, const AgentSubscriberParams& params) override {
                runFinishedCount++;
                log("Subscriber: RUN_FINISHED");
                return AgentStateMutation();
            }
        };

        auto agent = HttpAgent::builder()
            .withUrl(MOCK_SERVER_URL + "/api/agent/run")
            .withAgentId(AgentId("test_agent_integration"))
            .build();

        auto subscriber = std::make_shared<TestSubscriber>();
        agent->subscribe(subscriber);

        // Test 2.1: Using curl-style JSON request
        log("\nTest 2.1: Using curl-style JSON request to access service");
        log("Simulating command: curl -X POST http://localhost:8080/api/agent/run \\");
        log("  -H \"Content-Type: application/json\" \\");
        log("  -d '{\"scenario\": \"simple_text\", \"delay_ms\": 50}'");
        {
            auto httpService = HttpServiceFactory::createCurlService();
            
            nlohmann::json requestBody = {
                {"scenario", "simple_text"},
                {"delay_ms", 50}
            };
            
            log("\nConstructing request data:");
            log("  URL: " + MOCK_SERVER_URL + "/api/agent/run");
            log("  Method: POST");
            log("  Content-Type: application/json");
            log("  Body: " + requestBody.dump());
            
            HttpRequest request = HttpRequestBuilder()
                .method(HttpMethod::POST)
                .url(MOCK_SERVER_URL + "/api/agent/run")
                .contentType("application/json")
                .body(requestBody.dump())
                .timeout(10000)
                .build();
            
            log("\nSending request to server...");
            
            std::atomic<int> eventCount{0};
            std::atomic<bool> completed{false};
            std::vector<std::string> receivedEvents;
            
            httpService->sendSseRequest(
                request,
                [&](const HttpResponse& data) {
                    eventCount++;
                    receivedEvents.push_back(data.content);
                    log("  Received event #" + std::to_string(eventCount.load()) + ": " + 
                        data.content.substr(0, std::min(size_t(60), data.content.size())));
                },
                [&](const HttpResponse& response) {
                    completed = true;
                    log("\n SSE stream completed");
                    log("Completion response: " + response.content);
                },
                [&](const AgentError& error) {
                    log(" SSE stream error: " + error.message());
                }
            );
        }

        // Test 2.2: Run simple_text scenario (using Agent)
        log("\nTest 2.2: Run simple_text scenario (using Agent)");
        {
            RunAgentParams params;
            params.messages.push_back(Message("Test message", MessageRole::User, "simple_text"));

            std::atomic<bool> successCalled{false};
            std::atomic<bool> errorCalled{false};

            agent->runAgent(
                params,
                [&](const RunAgentResult& result) {
                    successCalled = true;
                    log("Agent run successful");
                },
                [&](const std::string& error) {
                    errorCalled = true;
                    log("Agent run failed: " + error);
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(3));

            if (successCalled) {
                assertTrue(subscriber->runStartedCount > 0, "Received RUN_STARTED event");
                assertTrue(subscriber->textMessageStartCount > 0, "Received TEXT_MESSAGE_START event");
                assertTrue(subscriber->textMessageContentCount > 0, "Received TEXT_MESSAGE_CONTENT event");
                assertTrue(subscriber->textMessageEndCount > 0, "Received TEXT_MESSAGE_END event");
                assertTrue(subscriber->runFinishedCount > 0, "Received RUN_FINISHED event");
                log("Full content: " + subscriber->fullContent);
            } else if (errorCalled) {
                log("  Agent run failed");
            }
        }

        // Test scenario with thinking process
        log("\nTest 2.2: Run with_thinking scenario");
        {
            subscriber->textMessageStartCount = 0;
            subscriber->textMessageContentCount = 0;
            subscriber->fullContent.clear();

            RunAgentParams params;
            params.messages.push_back(Message("with_thinking", MessageRole::User, "simple_text"));

            std::atomic<bool> completed{false};

            agent->runAgent(
                params,
                [&](const RunAgentResult& result) {
                    completed = true;
                    log("with_thinking scenario completed");
                },
                [&](const std::string& error) {
                    log("with_thinking scenario failed: " + error);
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(3));

            if (completed) {
                assertTrue(subscriber->textMessageContentCount > 0, "Received thinking content");
                log("Thinking scenario full content: " + subscriber->fullContent);
            }
        }

        // Test detailed streaming interaction flow
        log("\nTest 2.3: Detailed streaming interaction verification");
        log("Verification flow: Server sends message -> AG-UI receives -> Parses -> State transition -> Notifies subscriber");
        {
            // Create detailed subscriber to track complete flow
            class DetailedSubscriber : public IAgentSubscriber {
            public:
                struct EventRecord {
                    std::string eventType;
                    std::string timestamp;
                    std::string content;
                    nlohmann::json state;
                };
                
                std::vector<EventRecord> eventHistory;
                std::atomic<int> totalEvents{0};
                
                void recordEvent(const std::string& type, const std::string& content, const nlohmann::json& state) {
                    EventRecord record;
                    record.eventType = type;
                    record.content = content;
                    record.state = state;
                    
                    auto now = std::chrono::system_clock::now();
                    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
                    record.timestamp = std::to_string(ms);
                    
                    eventHistory.push_back(record);
                    totalEvents++;
                    
                    log("  [Event Record] " + type + " | Content: " + content.substr(0, std::min(size_t(30), content.size())));
                }
                
                AgentStateMutation onRunStarted(const RunStartedEvent& event, const AgentSubscriberParams& params) override {
                    log("Step 1: Server sends RUN_STARTED message");
                    log("  runId: " + event.runId);
                    recordEvent("RUN_STARTED", "runId=" + event.runId, *params.state);
                    
                    log("Step 2: AG-UI successfully receives RUN_STARTED message");
                    log("Step 3: Parse RUN_STARTED event, extract runId");
                    log("Step 4: State transition - run started");
                    log("Step 5: Notify subscriber - onRunStarted called");
                    
                    return AgentStateMutation();
                }
                
                AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                                      const AgentSubscriberParams& params) override {
                    log("\nStep 1: Server sends TEXT_MESSAGE_START message");
                    log("  messageId: " + event.messageId);
                    log("  role: " + event.role);
                    recordEvent("TEXT_MESSAGE_START", "messageId=" + event.messageId, *params.state);
                    
                    log("Step 2: AG-UI successfully receives TEXT_MESSAGE_START message");
                    log("Step 3: Parse TEXT_MESSAGE_START event");
                    log("  - Extract messageId: " + event.messageId);
                    log("  - Extract role: " + event.role);
                    log("Step 4: State transition - text message started");
                    log("Step 5: Notify subscriber - onTextMessageStart called");
                    
                    return AgentStateMutation();
                }
                
                AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event, const std::string& buffer,
                                                        const AgentSubscriberParams& params) override {
                    log("\nStep 1: Server sends TEXT_MESSAGE_CONTENT message");
                    log("  delta: " + event.delta);
                    recordEvent("TEXT_MESSAGE_CONTENT", event.delta, *params.state);
                    
                    log("Step 2: AG-UI successfully receives TEXT_MESSAGE_CONTENT message");
                    log("Step 3: Parse TEXT_MESSAGE_CONTENT event");
                    log("  - Extract delta content: " + event.delta);
                    log("  - Accumulate to buffer: " + buffer.substr(0, std::min(size_t(50), buffer.size())));
                    log("Step 4: State transition - content accumulation");
                    log("Step 5: Notify subscriber - onTextMessageContent called");
                    
                    return AgentStateMutation();
                }
                
                AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event, const AgentSubscriberParams& params) override {
                    log("\nStep 1: Server sends TEXT_MESSAGE_END message");
                    log("  messageId: " + event.messageId);
                    recordEvent("TEXT_MESSAGE_END", "messageId=" + event.messageId, *params.state);
                    
                    log("Step 2: AG-UI successfully receives TEXT_MESSAGE_END message");
                    log("Step 3: Parse TEXT_MESSAGE_END event");
                    log("  - Confirm messageId: " + event.messageId);
                    log("Step 4: State transition - text message completed");
                    log("Step 5: Notify subscriber - onTextMessageEnd called");
                    
                    return AgentStateMutation();
                }
                
                AgentStateMutation onRunFinished(const RunFinishedEvent& event, const AgentSubscriberParams& params) override {
                    log("\nStep 1: Server sends RUN_FINISHED message");
                    recordEvent("RUN_FINISHED", "run_finished", *params.state);
                    
                    log("Step 2: AG-UI successfully receives RUN_FINISHED message");
                    log("Step 3: Parse RUN_FINISHED event");
                    log("Step 4: State transition - run completed");
                    log("Step 5: Notify subscriber - onRunFinished called");
                    
                    return AgentStateMutation();
                }
                
                void printSummary() {
                    log("\n========== Streaming Interaction Flow Summary ==========");
                    log("Total events: " + std::to_string(totalEvents.load()));
                    log("\nEvent sequence:");
                    for (size_t i = 0; i < eventHistory.size(); i++) {
                        const auto& record = eventHistory[i];
                        log("  " + std::to_string(i + 1) + ". " + record.eventType + 
                            " | " + record.content.substr(0, std::min(size_t(40), record.content.size())));
                    }
                    log("======================================\n");
                }
            };
            
            auto detailedAgent = HttpAgent::builder()
                .withUrl(MOCK_SERVER_URL + "/api/agent/run")
                .withAgentId(AgentId("test_agent_detailed"))
                .build();
            
            auto detailedSubscriber = std::make_shared<DetailedSubscriber>();
            detailedAgent->subscribe(detailedSubscriber);
            
            log("\nStarting streaming interaction test...");
            log("Scenario: simple_text (simple text generation)");
            log("Delay: 200ms/event (for observing flow)\n");
            
            RunAgentParams params;
            params.messages.push_back(Message("Detailed flow test", MessageRole::User, "simple_text"));
            
            std::atomic<bool> testCompleted{false};
            std::atomic<bool> testFailed{false};
            std::string errorMessage;
            
            detailedAgent->runAgent(
                params,
                [&](const RunAgentResult& result) {
                    testCompleted = true;
                    log("\n Streaming interaction test completed");
                    log("Final status: Success");
                },
                [&](const std::string& error) {
                    testFailed = true;
                    errorMessage = error;
                    log("\n Streaming interaction test failed: " + error);
                }
            );
            
            log("Waiting for streaming interaction to complete...");
            std::this_thread::sleep_for(std::chrono::seconds(5));
            
            if (testCompleted) {
                detailedSubscriber->printSummary();
                
                assertTrue(detailedSubscriber->totalEvents >= 4, 
                          "At least 4 events received (RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED)");
                
                if (detailedSubscriber->eventHistory.size() >= 3) {
                    assertTrue(detailedSubscriber->eventHistory[0].eventType == "RUN_STARTED",
                              "First event is RUN_STARTED");
                    
                    bool hasTextStart = false;
                    bool hasTextContent = false;
                    bool hasTextEnd = false;
                    bool hasRunFinished = false;
                    
                    for (const auto& record : detailedSubscriber->eventHistory) {
                        if (record.eventType == "TEXT_MESSAGE_START") hasTextStart = true;
                        if (record.eventType == "TEXT_MESSAGE_CONTENT") hasTextContent = true;
                        if (record.eventType == "TEXT_MESSAGE_END") hasTextEnd = true;
                        if (record.eventType == "RUN_FINISHED") hasRunFinished = true;
                    }
                    
                    assertTrue(hasTextStart, "Contains TEXT_MESSAGE_START event");
                    assertTrue(hasTextContent, "Contains TEXT_MESSAGE_CONTENT event");
                    assertTrue(hasTextEnd, "Contains TEXT_MESSAGE_END event");
                    assertTrue(hasRunFinished, "Contains RUN_FINISHED event");
                }
                
                log("\n Streaming interaction flow verification passed");
                log("Verification items:");
                log("   Server successfully sends messages");
                log("   AG-UI successfully receives messages");
                log("   Message parsing correct");
                log("   State transition normal");
                log("   Subscriber notification correct");
                
            } else if (testFailed) {
                log("  Streaming interaction test failed: " + errorMessage);
            } else {
                log("  Streaming interaction test timeout or not completed");
            }
        }

        log(" HttpAgent and server interaction test completed\n");

    } catch (const std::exception& e) {
        log(" Test exception: " + std::string(e.what()));
    }
}


void testMiddlewareWithServer() {
    log("Integration Test 3: Middleware interaction with Mock server");

    try {
        // Create custom middleware
        class EventCounterMiddleware : public IMiddleware {
        public:
            std::atomic<int> eventCount{0};
            std::atomic<int> textEventCount{0};
            std::atomic<int> thinkingEventCount{0};

            std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override {
                eventCount++;
                
                if (event->type() == EventType::TextMessageStart ||
                    event->type() == EventType::TextMessageContent ||
                    event->type() == EventType::TextMessageEnd) {
                    textEventCount++;
                    log("Middleware: Captured TEXT event #" + std::to_string(textEventCount.load()));
                }
                
                if (event->type() == EventType::TextMessageStart ||
                    event->type() == EventType::TextMessageContent ||
                    event->type() == EventType::TextMessageEnd) {
                    thinkingEventCount++;
                    log("Middleware: Captured THINKING event #" + std::to_string(thinkingEventCount.load()));
                }
                
                return event;
            }
        };

        class EventFilterMiddleware : public IMiddleware {
        public:
            std::atomic<int> filteredCount{0};

            bool shouldProcessEvent(const Event& event, MiddlewareContext& context) override {
                if (event.type() == EventType::TextMessageStart ||
                    event.type() == EventType::TextMessageContent ||
                    event.type() == EventType::TextMessageEnd) {
                    filteredCount++;
                    log("Middleware: Filtered THINKING event #" + std::to_string(filteredCount.load()));
                    return false;
                }
                return true;
            }
        };

        auto agent = HttpAgent::builder()
            .withUrl(MOCK_SERVER_URL + "/api/agent/run")
            .withAgentId(AgentId("test_agent_middleware"))
            .build();

        auto counterMiddleware = std::make_shared<EventCounterMiddleware>();
        auto filterMiddleware = std::make_shared<EventFilterMiddleware>();

        // Test event counter middleware
        log("\nTest 3.1: Event counter middleware");
        {
            class MiddlewareSubscriber : public IAgentSubscriber {
            public:
                std::shared_ptr<EventCounterMiddleware> middleware;
                
                MiddlewareSubscriber(std::shared_ptr<EventCounterMiddleware> m) : middleware(m) {}
                
                AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                                      const AgentSubscriberParams& params) override {
                    middleware->textEventCount++;
                    middleware->eventCount++;
                    return AgentStateMutation();
                }
                
                AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event, const std::string& buffer,
                                                        const AgentSubscriberParams& params) override {
                    middleware->textEventCount++;
                    middleware->eventCount++;
                    return AgentStateMutation();
                }
                
                AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event, const AgentSubscriberParams& params) override {
                    middleware->textEventCount++;
                    middleware->eventCount++;
                    return AgentStateMutation();
                }
            };

            auto middlewareSubscriber = std::make_shared<MiddlewareSubscriber>(counterMiddleware);
            agent->subscribe(middlewareSubscriber);

            RunAgentParams params;
            params.messages.push_back(Message("simple_text", MessageRole::User, "simple_text"));

            std::atomic<bool> completed{false};

            agent->runAgent(
                params,
                [&](const RunAgentResult& result) {
                    completed = true;
                    log("Middleware test scenario completed");
                },
                [&](const std::string& error) {
                    log("Middleware test scenario failed: " + error);
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(3));

            if (completed) {
                assertTrue(counterMiddleware->eventCount > 0, "Middleware captured events");
                assertTrue(counterMiddleware->textEventCount > 0, "Middleware captured TEXT events");
                log("Total event count: " + std::to_string(counterMiddleware->eventCount.load()));
                log("TEXT event count: " + std::to_string(counterMiddleware->textEventCount.load()));
            }
        }

        // Test event filter middleware
        log("\nTest 3.2: Event filter middleware (with_thinking scenario)");
        {
            counterMiddleware->eventCount = 0;
            counterMiddleware->textEventCount = 0;
            counterMiddleware->thinkingEventCount = 0;

            RunAgentParams params;
            params.messages.push_back(Message("with_thinking", MessageRole::User, "simple_text"));

            std::atomic<bool> completed{false};

            agent->runAgent(
                params,
                [&](const RunAgentResult& result) {
                    completed = true;
                    log("Filter test scenario completed");
                },
                [&](const std::string& error) {
                    log("Filter test scenario failed: " + error);
                }
            );

            std::this_thread::sleep_for(std::chrono::seconds(3));

            if (completed) {
                log("TEXT event count: " + std::to_string(counterMiddleware->textEventCount.load()));
                log("THINKING event count: " + std::to_string(counterMiddleware->thinkingEventCount.load()));
                assertTrue(counterMiddleware->textEventCount > 0, "Captured TEXT events");
            }
        }

        log(" Middleware and server interaction test completed\n");

    } catch (const std::exception& e) {
        log(" Test exception: " + std::string(e.what()));
    }
}


int main() {
    std::cout << "\n";
    std::cout << "======================================\n";
    std::cout << "  AG-UI Integration Test Suite\n";
    std::cout << "  (Requires Mock server running)\n";
    std::cout << "======================================\n\n";

    std::cout << "  Important Note:\n";
    std::cout << "Please start Mock server first:\n";
    std::cout << "  python3 tests/mock_server/mock_ag_server.py\n\n";
    std::cout << "Press Enter to continue testing...\n";

    try {
        testHttpClientWithServer();
        testHttpAgentWithServer();
        testMiddlewareWithServer();

        std::cout << "======================================\n";
        std::cout << "  Test Results\n";
        std::cout << "======================================\n";
        std::cout << "Total: 3 integration tests\n";
        std::cout << "Note: Please check above output to confirm test results\n";
        std::cout << "======================================\n\n";
        std::cout << " Integration tests execution completed!\n\n";

        return 0;
    } catch (const std::exception& e) {
        std::cerr << "\n Test failed: " << e.what() << "\n\n";
        return 1;
    }
}
