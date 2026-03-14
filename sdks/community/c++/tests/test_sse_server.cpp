/**
 * @file test_sse_server.cpp
 * @brief Integration tests with Mock server
 *
 * Tests actual interaction between HTTP client, HttpAgent and middleware with Mock server
 *
 * Before running, please ensure Mock server is started:
 * python3 tests/mock_server/mock_ag_server.py
 *
 * Synchronization design:
 *   sendRequest / sendSseRequest / runAgent are all BLOCKING calls (libcurl sync).
 *   Each test runs the blocking call in a std::async thread and waits on the returned
 *   future with an explicit timeout, replacing the previous sleep_for approach.
 *   The future destructor guarantees the async thread finishes before local variables
 *   are destroyed, eliminating lifetime and data-race issues.
 */

#include <gtest/gtest.h>
#include <iostream>
#include <memory>
#include <vector>
#include <atomic>
#include <future>
#include <chrono>

#include "http/http_service.h"
#include "agent/http_agent.h"
#include "middleware/middleware.h"
#include "core/error.h"
#include "core/event.h"
#include "http_request_builder.h"

using namespace agui;

// Mock server address
const std::string MOCK_SERVER_URL = "http://localhost:8080";

// Global flag to track server availability
static bool g_serverAvailable = false;

// Timeout constants: each value is intentionally larger than the corresponding
// HTTP-level timeout so the future always becomes ready before we declare a
// test failure, yet the test never hangs indefinitely.
static const std::chrono::seconds HTTP_REQUEST_TIMEOUT{10};
static const std::chrono::seconds SSE_STREAM_TIMEOUT{15};
static const std::chrono::seconds AGENT_RUN_TIMEOUT{10};

/**
 * @brief Check if the mock server is available.
 *
 * Runs the blocking sendRequest in a std::async thread and waits up to 5 s.
 * Returns false on timeout or any network error.
 */
bool isServerAvailable() {
    try {
        auto httpService = HttpServiceFactory::createCurlService();

        HttpRequest request = HttpRequestBuilder()
            .method(HttpMethod::GET)
            .url(MOCK_SERVER_URL + "/health")
            .timeout(3000)  // 3 s HTTP-level timeout
            .build();

        bool success = false;

        // Run the blocking sendRequest in a background thread.
        auto fut = std::async(std::launch::async, [&]() {
            httpService->sendRequest(
                request,
                [&](const HttpResponse& response) {
                    success = response.isSuccess();
                },
                [&](const AgentError&) {
                    success = false;
                }
            );
        });

        // Wait slightly longer than the HTTP timeout to avoid false negatives.
        if (fut.wait_for(std::chrono::seconds(5)) != std::future_status::ready) {
            return false;  // fut destructor blocks until thread exits (≤ 3 s)
        }
        fut.get();
        return success;
    } catch (...) {
        return false;
    }
}

// Test fixture for integration tests
class IntegrationTest : public ::testing::Test {
protected:
    void SetUp() override {
        if (!g_serverAvailable) {
            GTEST_SKIP() << "Mock server is not available at " << MOCK_SERVER_URL
                         << ". Integration tests require the mock server to be running.\n"
                         << "Please start the server first:\n"
                         << "  cd tests/mock_server\n"
                         << "  python3 mock_ag_server.py";
        }
    }
};

// ── Test Suite 1: HTTP Client Integration Tests ───────────────────────────────

TEST_F(IntegrationTest, HttpClient_HealthCheckEndpoint) {
    auto httpService = HttpServiceFactory::createCurlService();

    HttpRequest request = HttpRequestBuilder()
        .method(HttpMethod::GET)
        .url(MOCK_SERVER_URL + "/health")
        .timeout(5000)
        .build();

    HttpResponse receivedResponse;
    bool errorOccurred = false;
    std::string errorMsg;

    // Run the blocking sendRequest in a background thread.
    auto fut = std::async(std::launch::async, [&]() {
        httpService->sendRequest(
            request,
            [&](const HttpResponse& response) {
                receivedResponse = response;
            },
            [&](const AgentError& error) {
                errorOccurred = true;
                errorMsg = error.message();
                std::cout << "Health check failed: " << error.message() << std::endl;
            }
        );
    });

    // Wait with an explicit deadline instead of sleeping.
    ASSERT_EQ(fut.wait_for(HTTP_REQUEST_TIMEOUT), std::future_status::ready)
        << "Health check request timed out after " << HTTP_REQUEST_TIMEOUT.count() << "s";
    fut.get();  // propagate any exception thrown inside the async task

    ASSERT_FALSE(errorOccurred) << "Health check error: " << errorMsg;
    EXPECT_TRUE(receivedResponse.isSuccess()) << "Health check should return success status";
    EXPECT_EQ(200, receivedResponse.statusCode) << "Status code should be 200";
    std::cout << "Response content: " << receivedResponse.body << std::endl;
}

TEST_F(IntegrationTest, HttpClient_GetScenariosList) {
    auto httpService = HttpServiceFactory::createCurlService();

    HttpRequest request = HttpRequestBuilder()
        .method(HttpMethod::GET)
        .url(MOCK_SERVER_URL + "/scenarios")
        .timeout(5000)
        .build();

    HttpResponse receivedResponse;
    bool errorOccurred = false;
    std::string errorMsg;

    auto fut = std::async(std::launch::async, [&]() {
        httpService->sendRequest(
            request,
            [&](const HttpResponse& response) {
                receivedResponse = response;
            },
            [&](const AgentError& error) {
                errorOccurred = true;
                errorMsg = error.message();
                std::cout << "Get scenarios list failed: " << error.message() << std::endl;
            }
        );
    });

    ASSERT_EQ(fut.wait_for(HTTP_REQUEST_TIMEOUT), std::future_status::ready)
        << "Get scenarios list timed out after " << HTTP_REQUEST_TIMEOUT.count() << "s";
    fut.get();

    ASSERT_FALSE(errorOccurred) << "Scenarios list error: " << errorMsg;
    EXPECT_TRUE(receivedResponse.isSuccess()) << "Scenarios list should return success";
    std::cout << "Scenarios list: " << receivedResponse.body << std::endl;
}

// ── Test Suite 2: HttpAgent Integration Tests ─────────────────────────────────

// Subscriber used by multiple HttpAgent tests
class TestSubscriber : public IAgentSubscriber {
public:
    std::atomic<int> textMessageStartCount{0};
    std::atomic<int> textMessageContentCount{0};
    std::atomic<int> textMessageEndCount{0};
    std::atomic<int> runStartedCount{0};
    std::atomic<int> runFinishedCount{0};
    // fullContent is written exclusively from the async thread and read only after
    // fut.get() provides the necessary happens-before guarantee.
    std::string fullContent;

    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                          const AgentSubscriberParams& params) override {
        textMessageStartCount++;
        std::cout << "Subscriber: TEXT_MESSAGE_START - messageId=" << event.messageId << std::endl;
        return AgentStateMutation();
    }

    AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event,
                                            const std::string& buffer,
                                            const AgentSubscriberParams& params) override {
        textMessageContentCount++;
        fullContent += event.delta;
        std::cout << "Subscriber: TEXT_MESSAGE_CONTENT - delta=" << event.delta << std::endl;
        return AgentStateMutation();
    }

    AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event,
                                        const AgentSubscriberParams& params) override {
        textMessageEndCount++;
        std::cout << "Subscriber: TEXT_MESSAGE_END" << std::endl;
        return AgentStateMutation();
    }

    AgentStateMutation onRunStarted(const RunStartedEvent& event,
                                    const AgentSubscriberParams& params) override {
        runStartedCount++;
        std::cout << "Subscriber: RUN_STARTED - runId=" << event.runId << std::endl;
        return AgentStateMutation();
    }

    AgentStateMutation onRunFinished(const RunFinishedEvent& event,
                                     const AgentSubscriberParams& params) override {
        runFinishedCount++;
        std::cout << "Subscriber: RUN_FINISHED" << std::endl;
        return AgentStateMutation();
    }
};

TEST_F(IntegrationTest, HttpAgent_CurlStyleJsonRequest_SseStreaming) {
    std::cout << "\n=== Testing curl-style JSON request with SSE streaming ===" << std::endl;

    auto httpService = HttpServiceFactory::createCurlService();

    nlohmann::json requestBody = {
        {"scenario", "simple_text"},
        {"delay_ms", 100}  // ms between streamed chunks
    };

    HttpRequest request = HttpRequestBuilder()
        .method(HttpMethod::POST)
        .url(MOCK_SERVER_URL + "/api/agent/run")
        .contentType("application/json")
        .body(requestBody.dump())
        .timeout(10000)
        .build();

    std::atomic<int> eventCount{0};
    std::atomic<bool> completed{false};
    std::atomic<bool> sseErrorOccurred{false};

    // Run the blocking sendSseRequest in a background thread.
    auto fut = std::async(std::launch::async, [&]() {
        httpService->sendSseRequest(
            request,
            [&](const HttpResponse& data) {
                eventCount++;
                std::cout << "  Received sse event #" << eventCount.load() << std::endl;
            },
            [&](const HttpResponse& response) {
                completed = true;
                std::cout << "Successful: SSE stream completed, response: "
                          << response.content << std::endl;
            },
            [&](const AgentError& error) {
                sseErrorOccurred = true;
                std::cout << "Error: SSE stream error: " << error.message() << std::endl;
            }
        );
    });

    ASSERT_EQ(fut.wait_for(SSE_STREAM_TIMEOUT), std::future_status::ready)
        << "SSE streaming timed out after " << SSE_STREAM_TIMEOUT.count() << "s";
    fut.get();

    EXPECT_TRUE(completed.load()) << "SSE stream should complete successfully";
    EXPECT_GT(eventCount.load(), 0) << "Should receive at least one SSE event";
    ASSERT_FALSE(sseErrorOccurred.load());
}

TEST_F(IntegrationTest, HttpAgent_SimpleTextScenario) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL + "/api/agent/run")
        .withAgentId(AgentId("test_agent_integration"))
        .build();

    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    RunAgentParams params;
    params.messages.push_back(Message("Test message", MessageRole::User, "simple_text content"));

    std::atomic<bool> successCalled{false};
    std::atomic<bool> errorCalled{false};
    // errorMessage written from async thread, read after fut.get() — no race.
    std::string errorMessage;

    auto fut = std::async(std::launch::async, [&]() {
        agent->runAgent(
            params,
            [&](const RunAgentResult& result) {
                successCalled = true;
                std::cout << "Agent run successful" << std::endl;
            },
            [&](const std::string& error) {
                errorCalled = true;
                errorMessage = error;
                std::cout << "Agent run failed: " << error << std::endl;
            }
        );
    });

    ASSERT_EQ(fut.wait_for(AGENT_RUN_TIMEOUT), std::future_status::ready)
        << "Agent run timed out after " << AGENT_RUN_TIMEOUT.count() << "s";
    fut.get();

    ASSERT_TRUE(successCalled.load()) << "Agent run should succeed, error: " << errorMessage;
    ASSERT_FALSE(errorCalled.load());
    EXPECT_GT(subscriber->runStartedCount.load(), 0) << "Should receive RUN_STARTED event";
    EXPECT_GT(subscriber->textMessageStartCount.load(), 0) << "Should receive TEXT_MESSAGE_START event";
    EXPECT_GT(subscriber->textMessageContentCount.load(), 0) << "Should receive TEXT_MESSAGE_CONTENT event";
    EXPECT_GT(subscriber->textMessageEndCount.load(), 0) << "Should receive TEXT_MESSAGE_END event";
    EXPECT_GT(subscriber->runFinishedCount.load(), 0) << "Should receive RUN_FINISHED event";
    std::cout << "Full content: " << subscriber->fullContent << std::endl;
}

TEST_F(IntegrationTest, HttpAgent_WithThinkingScenario) {
    auto agent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL + "/api/agent/run")
        .withAgentId(AgentId("test_agent_thinking"))
        .build();

    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    RunAgentParams params;
    params.messages.push_back(Message("with_thinking", MessageRole::User, "simple_text"));

    std::atomic<bool> completed{false};
    std::string errorMessage;

    auto fut = std::async(std::launch::async, [&]() {
        agent->runAgent(
            params,
            [&](const RunAgentResult& result) {
                completed = true;
                std::cout << "with_thinking scenario completed" << std::endl;
            },
            [&](const std::string& error) {
                errorMessage = error;
                std::cout << "with_thinking scenario failed: " << error << std::endl;
            }
        );
    });

    ASSERT_EQ(fut.wait_for(AGENT_RUN_TIMEOUT), std::future_status::ready)
        << "with_thinking scenario timed out after " << AGENT_RUN_TIMEOUT.count() << "s";
    fut.get();

    ASSERT_TRUE(completed.load()) << "with_thinking scenario should complete, error: " << errorMessage;
    EXPECT_GT(subscriber->textMessageContentCount.load(), 0) << "Should receive thinking content";
}

TEST_F(IntegrationTest, HttpAgent_DetailedStreamingInteractionFlow) {
    std::cout << "\n=== Testing detailed streaming interaction flow ===" << std::endl;

    // Detailed subscriber defined locally to capture the full event timeline.
    // eventHistory is written exclusively from the async thread (inside runAgent)
    // and read only after fut.get(), so no mutex is required.
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

        void recordEvent(const std::string& type, const std::string& content,
                         const nlohmann::json& state) {
            EventRecord record;
            record.eventType = type;
            record.content   = content;
            record.state     = state;

            auto now = std::chrono::system_clock::now();
            auto ms  = std::chrono::duration_cast<std::chrono::milliseconds>(
                           now.time_since_epoch()).count();
            record.timestamp = std::to_string(ms);

            eventHistory.push_back(record);
            totalEvents++;

            std::cout << "  [Event Record] " << type << " | Content: "
                      << content.substr(0, std::min(size_t(30), content.size()))
                      << std::endl;
        }

        AgentStateMutation onRunStarted(const RunStartedEvent& event,
                                        const AgentSubscriberParams& params) override {
            recordEvent("RUN_STARTED", "runId=" + event.runId, *params.state);
            return AgentStateMutation();
        }

        AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                              const AgentSubscriberParams& params) override {
            recordEvent("TEXT_MESSAGE_START", "messageId=" + event.messageId, *params.state);
            return AgentStateMutation();
        }

        AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event,
                                                const std::string& buffer,
                                                const AgentSubscriberParams& params) override {
            recordEvent("TEXT_MESSAGE_CONTENT", event.delta, *params.state);
            return AgentStateMutation();
        }

        AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event,
                                            const AgentSubscriberParams& params) override {
            recordEvent("TEXT_MESSAGE_END", "messageId=" + event.messageId, *params.state);
            return AgentStateMutation();
        }

        AgentStateMutation onRunFinished(const RunFinishedEvent& event,
                                         const AgentSubscriberParams& params) override {
            recordEvent("RUN_FINISHED", "run_finished", *params.state);
            return AgentStateMutation();
        }
    };

    auto detailedAgent = HttpAgent::builder()
        .withUrl(MOCK_SERVER_URL + "/api/agent/run")
        .withAgentId(AgentId("test_agent_detailed"))
        .build();

    auto detailedSubscriber = std::make_shared<DetailedSubscriber>();
    detailedAgent->subscribe(detailedSubscriber);

    RunAgentParams params;
    params.messages.push_back(Message("Detailed flow test", MessageRole::User, "simple_text"));

    std::atomic<bool> testCompleted{false};
    // errorMessage written from async thread, read after fut.get() — no race.
    std::string errorMessage;

    auto fut = std::async(std::launch::async, [&]() {
        detailedAgent->runAgent(
            params,
            [&](const RunAgentResult& result) {
                testCompleted = true;
            },
            [&](const std::string& error) {
                errorMessage = error;
            }
        );
    });

    // fut destructor (on scope exit) blocks until the async thread finishes,
    // so all subscriber writes to eventHistory complete before the assertions below.
    ASSERT_EQ(fut.wait_for(AGENT_RUN_TIMEOUT), std::future_status::ready)
        << "Detailed streaming interaction flow timed out after "
        << AGENT_RUN_TIMEOUT.count() << "s";
    fut.get();

    ASSERT_TRUE(testCompleted.load())
        << "Streaming interaction test should complete, error: " << errorMessage;

    ASSERT_GE(detailedSubscriber->totalEvents.load(), 5)
        << "Should receive at least 4 events "
           "(RUN_STARTED, TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END, RUN_FINISHED)";

    if (detailedSubscriber->eventHistory.size() >= 3) {
        bool hasTextStart   = false;
        bool hasTextContent = false;
        bool hasTextEnd     = false;
        bool hasRunFinished = false;

        for (const auto& record : detailedSubscriber->eventHistory) {
            if (record.eventType == "TEXT_MESSAGE_START")   hasTextStart   = true;
            if (record.eventType == "TEXT_MESSAGE_CONTENT") hasTextContent = true;
            if (record.eventType == "TEXT_MESSAGE_END")     hasTextEnd     = true;
            if (record.eventType == "RUN_FINISHED")         hasRunFinished = true;
        }

        EXPECT_TRUE(hasTextStart)   << "Should contain TEXT_MESSAGE_START event";
        EXPECT_TRUE(hasTextContent) << "Should contain TEXT_MESSAGE_CONTENT event";
        EXPECT_TRUE(hasTextEnd)     << "Should contain TEXT_MESSAGE_END event";
        EXPECT_TRUE(hasRunFinished) << "Should contain RUN_FINISHED event";
    }

    std::cout << "\nStreaming interaction flow verification passed" << std::endl;
}

// ── Test Environment Setup ────────────────────────────────────────────────────

// Checks server availability once before any test in this binary runs.
class IntegrationTestEnvironment : public ::testing::Environment {
public:
    void SetUp() override {
        std::cout << "Checking mock server availability at " << MOCK_SERVER_URL << "...\n";

        g_serverAvailable = isServerAvailable();

        if (!g_serverAvailable) {
            std::cerr << "\nWARNING: Mock server is not running at " << MOCK_SERVER_URL << "\n";
            std::cerr << "\nPlease start the mock server first:\n";
            std::cerr << "  cd tests/mock_server\n";
            std::cerr << "  python3 mock_ag_server.py\n";
            std::cerr << "\nAll integration tests will be skipped.\n";
            std::cerr << "This ensures CI doesn't report false positives.\n\n";
        } else {
            std::cout << "Mock server is available and responding\n\n";
        }
    }
};

// Registered automatically by gtest_main
static ::testing::Environment* const test_env =
    ::testing::AddGlobalTestEnvironment(new IntegrationTestEnvironment);
