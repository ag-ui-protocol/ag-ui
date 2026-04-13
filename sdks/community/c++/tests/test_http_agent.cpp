/**
 * @file test_http_agent.cpp
 * @brief HttpAgent end-to-end tests
 * 
 * Tests HttpAgent building, running, state management and subscriber management
 */

#include <gtest/gtest.h>
#include <memory>
#include <stdexcept>
#include <vector>

#include "agent/http_agent.h"
#include "core/error.h"
#include "core/event.h"
#include "core/subscriber.h"
#include "core/session_types.h"

using namespace agui;

class TestSubscriber : public IAgentSubscriber {
public:
    int textMessageStartCount = 0;
    int textMessageChunkCount = 0;
    int toolCallStartCount = 0;
    int toolCallChunkCount = 0;

    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                          const AgentSubscriberParams& params) override {
        textMessageStartCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onTextMessageChunk(const TextMessageChunkEvent& event,
                                          const AgentSubscriberParams& params) override {
        (void)event;
        (void)params;
        textMessageChunkCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onToolCallStart(const ToolCallStartEvent& event,
                                       const AgentSubscriberParams& params) override {
        (void)event;
        (void)params;
        toolCallStartCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onToolCallChunk(const ToolCallChunkEvent& event,
                                       const AgentSubscriberParams& params) override {
        (void)event;
        (void)params;
        toolCallChunkCount++;
        return AgentStateMutation();
    }
};

class ThrowingTextContentSubscriber : public IAgentSubscriber {
public:
    AgentStateMutation onTextMessageContent(const TextMessageContentEvent&,
                                            const std::string&,
                                            const AgentSubscriberParams&) override {
        throw std::runtime_error("text content subscriber failure");
    }
};

class ThrowingNewMessageSubscriber : public IAgentSubscriber {
public:
    void onNewMessage(const Message&, const AgentSubscriberParams&) override {
        throw std::runtime_error("new message subscriber failure");
    }
};

class ThrowingStateChangedSubscriber : public IAgentSubscriber {
public:
    void onStateChanged(const AgentSubscriberParams&) override {
        throw std::runtime_error("state changed subscriber failure");
    }
};

class ThrowingEventMiddlewareForAgent : public IMiddleware {
public:
    std::unique_ptr<Event> onEvent(std::unique_ptr<Event> event, MiddlewareContext& context) override {
        (void)event;
        (void)context;
        throw std::runtime_error("agent middleware event failure");
    }
};

class StopExecutionMiddlewareForAgent : public IMiddleware {
public:
    bool shouldContinue(const RunAgentInput&, MiddlewareContext& context) override {
        context.shouldContinue = false;
        return false;
    }
};

class ThrowingRequestMiddlewareForAgent : public IMiddleware {
public:
    RunAgentInput onRequest(const RunAgentInput&, MiddlewareContext&) override {
        throw std::runtime_error("request middleware exploded");
    }
};

class ThrowingShouldContinueMiddlewareForAgent : public IMiddleware {
public:
    bool shouldContinue(const RunAgentInput&, MiddlewareContext&) override {
        throw std::runtime_error("shouldContinue exploded");
    }
};

// HttpAgent Builder Tests
TEST(HttpAgentTest, BuilderBasicConstruction) {
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("test_agent_123"))
        .build();

    ASSERT_NE(agent, nullptr);
    EXPECT_EQ(agent->agentId(), "test_agent_123");
}


TEST(HttpAgentTest, BuilderParameterConfiguration) {
    std::vector<Message> initialMessages = {
        Message("msg_1", MessageRole::User, "Hello"),
        Message("msg_2", MessageRole::Assistant, "Hi there!")
    };

    nlohmann::json initialState = {
        {"counter", 0},
        {"status", "ready"}
    };

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_456"))
        .withBearerToken("test_token")
        .withTimeout(10)
        .withInitialMessages(initialMessages)
        .withInitialState(initialState)
        .build();

    ASSERT_NE(agent, nullptr);
    EXPECT_EQ(agent->messages().size(), 2);
    EXPECT_EQ(agent->messages()[0].id(), "msg_1");
    EXPECT_EQ(agent->messages()[1].id(), "msg_2");
}


TEST(HttpAgentTest, BuilderMethodChaining) {
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withHeader("X-Custom-Header", "custom_value")
        .withHeader("X-Request-ID", "req_789")
        .withBearerToken("token_abc")
        .withTimeout(15)
        .withAgentId(AgentId("agent_chain"))
        .build();

    ASSERT_NE(agent, nullptr);
    EXPECT_EQ(agent->agentId(), "agent_chain");
}

// Message Management Tests
TEST(HttpAgentTest, MessageManagement) {
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_msg"))
        .build();

    EXPECT_TRUE(agent->messages().empty());

    Message msg1("msg_1", MessageRole::User, "Hello");
    agent->addMessage(msg1);
    EXPECT_EQ(agent->messages().size(), 1);
    EXPECT_EQ(agent->messages()[0].id(), "msg_1");

    Message msg2("msg_2", MessageRole::Assistant, "Hi");
    agent->addMessage(msg2);
    EXPECT_EQ(agent->messages().size(), 2);

    std::vector<Message> newMessages = {
        Message("msg_3", MessageRole::User, "New message 1"),
        Message("msg_4", MessageRole::Assistant, "New message 2"),
        Message("msg_5", MessageRole::User, "New message 3")
    };
    agent->setMessages(newMessages);
    EXPECT_EQ(agent->messages().size(), 3);
    EXPECT_EQ(agent->messages()[0].id(), "msg_3");
    EXPECT_EQ(agent->messages()[2].id(), "msg_5");
}


// Subscriber Management Tests
TEST(HttpAgentTest, SubscriberManagement) {
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_sub"))
        .build();

    auto subscriber1 = std::make_shared<TestSubscriber>();
    auto subscriber2 = std::make_shared<TestSubscriber>();

    agent->subscribe(subscriber1);
    agent->subscribe(subscriber2);

    agent->unsubscribe(subscriber1);

    agent->clearSubscribers();
    
    // Test passes if no exceptions thrown
    SUCCEED();
}


TEST(HttpAgentTest, SubscriberNoneCallbackTriggering) {
    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_callback"))
        .build();

    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    // Note: This only tests subscriber registration, actual callback triggering requires real events
    EXPECT_EQ(subscriber->textMessageStartCount, 0);
}

// Multiple Agents Tests
TEST(HttpAgentTest, MultipleAgentInstances) {
    auto agent1 = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_1"))
        .build();

    auto agent2 = HttpAgent::builder()
        .withUrl("http://localhost:8081")
        .withAgentId(AgentId("agent_2"))
        .build();

    auto agent3 = HttpAgent::builder()
        .withUrl("http://localhost:8082")
        .withAgentId(AgentId("agent_3"))
        .build();

    EXPECT_EQ(agent1->agentId(), "agent_1");
    EXPECT_EQ(agent2->agentId(), "agent_2");
    EXPECT_EQ(agent3->agentId(), "agent_3");
}

// ─── Mock HTTP Service ───────────────────────────────────────────────────────

/**
 * @brief Synchronous mock that feeds pre-configured SSE chunks to HttpAgent
 *        without any real network I/O.
 */
class MockHttpService : public IHttpService {
public:
    HttpRequest lastSseRequest;
    // Chunks fed to onData callback, one by one
    std::vector<std::string> sseChunks;
    // When true, calls errorCallbackFunc instead of streaming
    bool simulateNetworkError = false;
    std::string networkErrorMessage = "Connection refused";
    bool throwOnSend = false;
    // When true, calls onComplete with cancelled=true (simulates cancelRun())
    bool simulateCancelled = false;
    // When true, calls onComplete with a non-200 HTTP status code
    bool simulateHttpError = false;
    int httpErrorStatusCode = 500;

    void sendRequest(const HttpRequest&, HttpResponseCallback, HttpErrorCallback) override {}

    void sendSseRequest(const HttpRequest& request, SseDataCallback onData,
                        SseCompleteCallback onComplete, HttpErrorCallback onError) override {
        lastSseRequest = request;
        if (throwOnSend) {
            throw std::runtime_error("sendSseRequest exploded");
        }
        if (simulateNetworkError) {
            if (onError) {
                onError(AgentError(ErrorType::Network, ErrorCode::NetworkError, networkErrorMessage));
            }
            return;
        }

        if (simulateCancelled) {
            if (onComplete) {
                HttpResponse resp;
                resp.cancelled = true;
                onComplete(resp);
            }
            return;
        }

        if (simulateHttpError) {
            if (onComplete) {
                HttpResponse resp;
                resp.statusCode = httpErrorStatusCode;
                onComplete(resp);
            }
            return;
        }

        // Feed each SSE chunk synchronously
        for (const auto& chunk : sseChunks) {
            if (onData) {
                HttpResponse resp;
                resp.statusCode = 200;
                resp.content = chunk;
                onData(resp);
            }
        }

        // Signal stream completion
        if (onComplete) {
            HttpResponse resp;
            resp.statusCode = 200;
            resp.content = "success";
            onComplete(resp);
        }
    }
};

// Helper: build a minimal agent with the given mock service injected
static std::unique_ptr<HttpAgent> makeAgentWithMock(std::unique_ptr<MockHttpService> mock) {
    auto agent = HttpAgent::builder()
        .withUrl("http://mock-host/run")
        .withAgentId(AgentId("mock_agent"))
        .build();
    agent->setHttpService(std::move(mock));
    return agent;
}

// ─── Core Path Tests ─────────────────────────────────────────────────────────

TEST(HttpAgentTest, RunAgentCallsOnSuccessOnNormalCompletion) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"delta\":\"Hello\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"msg1\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    RunAgentResult capturedResult;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult& result) {
            successCalled = true;
            capturedResult = result;
        },
        [&](const std::string&) {
            errorCalled = true;
        });

    EXPECT_TRUE(successCalled);
    EXPECT_FALSE(errorCalled);
    // One new message should have been produced during this run
    ASSERT_EQ(capturedResult.newMessages.size(), 1);
    EXPECT_EQ(capturedResult.newMessages[0].content(), "Hello");
}

TEST(HttpAgentTest, RunAgentCallsOnErrorOnRunErrorEvent) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"RUN_ERROR\",\"message\":\"Something went wrong\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& err) {
            errorCalled = true;
            capturedError = err;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_FALSE(capturedError.empty());
}

TEST(HttpAgentTest, RunAgentCallsOnErrorOnNetworkFailure) {
    auto mock = std::make_unique<MockHttpService>();
    mock->simulateNetworkError = true;
    mock->networkErrorMessage = "Connection refused";

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            EXPECT_TRUE(error.find("Connection refused") != std::string::npos);
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
}

TEST(HttpAgentTest, RunAgentFailsOnMalformedJsonEvent) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {not valid json}\n\n",
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("Malformed SSE event payload"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentSkipsUnknownEventTypeAndSucceeds) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"FUTURE_EVENT\",\"payload\":123}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"delta\":\"Hello\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"msg1\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult& result) {
            successCalled = true;
            ASSERT_EQ(result.newMessages.size(), 1);
            EXPECT_EQ(result.newMessages[0].content(), "Hello");
        },
        [&](const std::string&) {
            errorCalled = true;
        });

    EXPECT_TRUE(successCalled);
    EXPECT_FALSE(errorCalled);
}

TEST(HttpAgentTest, RunAgentFailsWhenEventMiddlewareThrows) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    agent->use(std::make_shared<ThrowingEventMiddlewareForAgent>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("agent middleware event failure"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenTypeFieldIsMissing) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("type"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsForKnownEventMissingRequiredField) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"delta\":\"Hello\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("messageId"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsForLifecycleViolation) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"delta\":\"Hello\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("has not been started"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenRunFinishesWithIncompleteMessage) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("RUN_FINISHED"), std::string::npos);
    EXPECT_NE(capturedError.find("msg1"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentAppliesTextMessageChunksDirectly) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"messageId\":\"msg1\",\"role\":\"assistant\",\"name\":\"planner\",\"delta\":\"Hello\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"delta\":\" World\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    bool successCalled = false;
    bool errorCalled = false;
    RunAgentResult capturedResult;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult& result) {
            successCalled = true;
            capturedResult = result;
        },
        [&](const std::string&) {
            errorCalled = true;
        });

    EXPECT_TRUE(successCalled);
    EXPECT_FALSE(errorCalled);
    ASSERT_EQ(capturedResult.newMessages.size(), 1);
    EXPECT_EQ(capturedResult.newMessages[0].content(), "Hello World");
    EXPECT_EQ(capturedResult.newMessages[0].name(), "planner");
    EXPECT_EQ(subscriber->textMessageStartCount, 0);
    EXPECT_EQ(subscriber->textMessageChunkCount, 2);
}

TEST(HttpAgentTest, RunAgentAppliesToolCallChunksDirectly) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"call1\",\"toolCallName\":\"search\",\"parentMessageId\":\"msg1\",\"delta\":\"{\\\"query\\\":\"}\n\n",
        "data: {\"type\":\"TOOL_CALL_CHUNK\",\"delta\":\"\\\"weather\\\"}\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    bool successCalled = false;
    bool errorCalled = false;
    RunAgentResult capturedResult;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult& result) {
            successCalled = true;
            capturedResult = result;
        },
        [&](const std::string&) {
            errorCalled = true;
        });

    EXPECT_TRUE(successCalled);
    EXPECT_FALSE(errorCalled);
    ASSERT_EQ(capturedResult.newMessages.size(), 1);
    ASSERT_EQ(capturedResult.newMessages[0].toolCalls().size(), 1);
    EXPECT_EQ(capturedResult.newMessages[0].id(), "msg1");
    EXPECT_EQ(capturedResult.newMessages[0].toolCalls()[0].function.name, "search");
    EXPECT_EQ(capturedResult.newMessages[0].toolCalls()[0].function.arguments, "{\"query\":\"weather\"}");
    EXPECT_EQ(subscriber->toolCallStartCount, 0);
    EXPECT_EQ(subscriber->toolCallChunkCount, 2);
}

TEST(HttpAgentTest, RunAgentFailsWhenTextContentSubscriberThrows) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg1\",\"delta\":\"Hello\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    agent->subscribe(std::make_shared<ThrowingTextContentSubscriber>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("Subscriber callback failed"), std::string::npos);
    EXPECT_NE(capturedError.find("event notification"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenNewMessageSubscriberThrows) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    agent->subscribe(std::make_shared<ThrowingNewMessageSubscriber>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("onNewMessage"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenStateChangedSubscriberThrows) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"STATE_SNAPSHOT\",\"snapshot\":{\"count\":1}}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));
    agent->subscribe(std::make_shared<ThrowingStateChangedSubscriber>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("onStateChanged"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenActivityDeltaContentIsInvalidJson) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"ACTIVITY_DELTA\",\"messageId\":\"act1\",\"activityType\":\"PLAN\",\"patch\":[{\"op\":\"replace\",\"path\":\"/step\",\"value\":2}]}\n\n",
    };

    Message activity = Message::createWithId("act1", MessageRole::Activity, "{not-json");
    activity.setActivityType("PLAN");

    auto agent = HttpAgent::builder()
        .withUrl("http://mock-host/run")
        .withAgentId(AgentId("mock_agent"))
        .withInitialMessages({activity})
        .build();
    agent->setHttpService(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("ActivityDeltaEvent"), std::string::npos);
    EXPECT_NE(capturedError.find("act1"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenActivityDeltaPatchCannotBeApplied) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"ACTIVITY_DELTA\",\"messageId\":\"act1\",\"activityType\":\"PLAN\",\"patch\":[{\"op\":\"remove\",\"path\":\"/missing\"}]}\n\n",
    };

    Message activity = Message::createWithId("act1", MessageRole::Activity, "{\"step\":1}");
    activity.setActivityType("PLAN");

    auto agent = HttpAgent::builder()
        .withUrl("http://mock-host/run")
        .withAgentId(AgentId("mock_agent"))
        .withInitialMessages({activity})
        .build();
    agent->setHttpService(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("ActivityDeltaEvent"), std::string::npos);
    EXPECT_NE(capturedError.find("act1"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentMiddlewareStopUsesSafeErrorCallback) {
    auto mock = std::make_unique<MockHttpService>();
    auto agent = makeAgentWithMock(std::move(mock));
    agent->use(std::make_shared<StopExecutionMiddlewareForAgent>());

    bool errorCalled = false;

    EXPECT_NO_THROW(agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {},
        [&](const std::string& error) {
            errorCalled = true;
            EXPECT_EQ(error, "Middleware stopped execution");
            throw std::runtime_error("onError exploded");
        }));

    EXPECT_TRUE(errorCalled);
}

TEST(HttpAgentTest, RunAgentStartFailureUsesSafeErrorCallback) {
    auto mock = std::make_unique<MockHttpService>();
    mock->throwOnSend = true;

    auto agent = makeAgentWithMock(std::move(mock));

    bool errorCalled = false;

    EXPECT_NO_THROW(agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {},
        [&](const std::string& error) {
            errorCalled = true;
            EXPECT_NE(error.find("Failed to start agent run"), std::string::npos);
            throw std::runtime_error("onError exploded");
        }));

    EXPECT_TRUE(errorCalled);
}

TEST(HttpAgentTest, RunAgentReportsRequestMiddlewareException) {
    auto mock = std::make_unique<MockHttpService>();
    auto agent = makeAgentWithMock(std::move(mock));
    agent->use(std::make_shared<ThrowingRequestMiddlewareForAgent>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    EXPECT_NO_THROW(agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        }));

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("Request middleware failed"), std::string::npos);
    EXPECT_NE(capturedError.find("request middleware exploded"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentReportsShouldContinueException) {
    auto mock = std::make_unique<MockHttpService>();
    auto agent = makeAgentWithMock(std::move(mock));
    agent->use(std::make_shared<ThrowingShouldContinueMiddlewareForAgent>());

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    EXPECT_NO_THROW(agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        }));

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("Request middleware failed"), std::string::npos);
    EXPECT_NE(capturedError.find("shouldContinue exploded"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentSerializesParentRunIdFromParams) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };
    auto* mockPtr = mock.get();

    auto agent = makeAgentWithMock(std::move(mock));

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";
    params.withParentRunId("parent-42");

    bool successCalled = false;
    agent->runAgent(
        params,
        [&](const RunAgentResult&) { successCalled = true; },
        [&](const std::string&) { FAIL() << "runAgent should not fail"; });

    ASSERT_TRUE(successCalled);
    nlohmann::json requestJson = nlohmann::json::parse(mockPtr->lastSseRequest.body);
    ASSERT_TRUE(requestJson.contains("parentRunId"));
    EXPECT_EQ(requestJson["parentRunId"], "parent-42");
}

TEST(HttpAgentTest, RunAgentFailsWhenFirstTextChunkHasNoMessageContext) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CHUNK\",\"delta\":\"Hello\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) { successCalled = true; },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("TEXT_MESSAGE_CHUNK"), std::string::npos);
    EXPECT_NE(capturedError.find("missing required context"), std::string::npos);
}

TEST(HttpAgentTest, RunAgentFailsWhenToolCallChunkCannotCreateTarget) {
    auto mock = std::make_unique<MockHttpService>();
    mock->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"TOOL_CALL_CHUNK\",\"toolCallId\":\"tool-1\",\"delta\":\"{}\"}\n\n",
    };

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    RunAgentParams params;
    params.threadId = "t1";
    params.runId = "r1";

    agent->runAgent(
        params,
        [&](const RunAgentResult&) { successCalled = true; },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("TOOL_CALL_CHUNK"), std::string::npos);
    EXPECT_NE(capturedError.find("toolCallName"), std::string::npos);
}

// ─── H-5: Multi-run state persistence ────────────────────────────────────────

// Verify that state and messages produced by run N are available to run N+1.
TEST(HttpAgentTest, MultiRunStatePersistsAcrossRuns) {
    // Run 1: server sends a STATE_SNAPSHOT and a text message
    auto mock1 = std::make_unique<MockHttpService>();
    mock1->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
        "data: {\"type\":\"STATE_SNAPSHOT\",\"snapshot\":{\"counter\":1}}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_START\",\"messageId\":\"msg-1\",\"role\":\"assistant\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"msg-1\",\"delta\":\"hello\"}\n\n",
        "data: {\"type\":\"TEXT_MESSAGE_END\",\"messageId\":\"msg-1\"}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r1\"}\n\n",
    };

    auto agent = HttpAgent::builder()
        .withUrl("http://mock-host/run")
        .withAgentId(AgentId("mock_agent"))
        .build();
    agent->setHttpService(std::move(mock1));

    bool run1Success = false;
    RunAgentParams params1;
    params1.threadId = "t1";
    params1.runId = "r1";
    agent->runAgent(params1,
                    [&](const RunAgentResult&) { run1Success = true; },
                    [](const std::string&) {});

    ASSERT_TRUE(run1Success);
    // State from run 1 should be persisted
    EXPECT_EQ(agent->state().value("counter", 0), 1);
    // Message from run 1 should be in history
    ASSERT_EQ(agent->messages().size(), 1u);
    EXPECT_EQ(agent->messages()[0].id(), "msg-1");

    // Run 2: server sends a STATE_DELTA on top of run 1 state
    auto mock2 = std::make_unique<MockHttpService>();
    mock2->sseChunks = {
        "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"r2\"}\n\n",
        "data: {\"type\":\"STATE_DELTA\",\"delta\":[{\"op\":\"replace\",\"path\":\"/counter\",\"value\":2}]}\n\n",
        "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"r2\"}\n\n",
    };
    agent->setHttpService(std::move(mock2));

    bool run2Success = false;
    RunAgentParams params2;
    params2.threadId = "t1";
    params2.runId = "r2";
    agent->runAgent(params2,
                    [&](const RunAgentResult& result) {
                        run2Success = true;
                        // newState in result should reflect the delta
                        EXPECT_EQ(result.newState.value("counter", 0), 2);
                        // newMessages should be empty (no messages added in run 2)
                        EXPECT_TRUE(result.newMessages.empty());
                    },
                    [](const std::string&) {});

    ASSERT_TRUE(run2Success);
    // Agent's persistent state should now be counter=2
    EXPECT_EQ(agent->state().value("counter", 0), 2);
    // Message from run 1 is still in history (accumulates across runs)
    EXPECT_EQ(agent->messages().size(), 1u);
}

// ─── H-6: Per-run subscriber cleanup ─────────────────────────────────────────

// Counting subscriber that records how many times onRunFinished is called.
class CountingRunFinishedSubscriber : public IAgentSubscriber {
public:
    int runFinishedCount = 0;
    AgentStateMutation onRunFinished(const RunFinishedEvent&, const AgentSubscriberParams&) override {
        runFinishedCount++;
        return AgentStateMutation();
    }
};

// Per-run subscribers added via RunAgentParams must NOT be called in subsequent runs.
TEST(HttpAgentTest, PerRunSubscribersAreRemovedAfterRun) {
    auto makeChunks = [](const std::string& runId) -> std::vector<std::string> {
        return {
            "data: {\"type\":\"RUN_STARTED\",\"threadId\":\"t1\",\"runId\":\"" + runId + "\"}\n\n",
            "data: {\"type\":\"RUN_FINISHED\",\"threadId\":\"t1\",\"runId\":\"" + runId + "\"}\n\n",
        };
    };

    auto agent = HttpAgent::builder()
        .withUrl("http://mock-host/run")
        .withAgentId(AgentId("mock_agent"))
        .build();

    // Run 1: add a per-run subscriber via RunAgentParams
    auto perRunSub = std::make_shared<CountingRunFinishedSubscriber>();
    auto mock1 = std::make_unique<MockHttpService>();
    mock1->sseChunks = makeChunks("r1");
    agent->setHttpService(std::move(mock1));

    RunAgentParams params1;
    params1.threadId = "t1";
    params1.runId = "r1";
    params1.subscribers.push_back(perRunSub);

    agent->runAgent(params1, [](const RunAgentResult&) {}, [](const std::string&) {});

    EXPECT_EQ(perRunSub->runFinishedCount, 1) << "Per-run subscriber should fire once in run 1";

    // Run 2: the per-run subscriber from run 1 must NOT be present
    auto mock2 = std::make_unique<MockHttpService>();
    mock2->sseChunks = makeChunks("r2");
    agent->setHttpService(std::move(mock2));

    RunAgentParams params2;
    params2.threadId = "t1";
    params2.runId = "r2";
    // No per-run subscriber added for run 2

    agent->runAgent(params2, [](const RunAgentResult&) {}, [](const std::string&) {});

    // Count should still be 1, not 2 — the subscriber was cleaned up after run 1
    EXPECT_EQ(perRunSub->runFinishedCount, 1)
        << "Per-run subscriber from run 1 must not fire during run 2";
}

// ─── cancelRun test ───────────────────────────────────────────────────────────

// Cancellation must invoke onError (not onSuccess) with a message containing "cancelled".
TEST(HttpAgentTest, CancelledRunCallsOnError) {
    auto mock = std::make_unique<MockHttpService>();
    mock->simulateCancelled = true;

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {
            successCalled = true;
        },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("cancelled"), std::string::npos);
}

// ─── roleFromString test ──────────────────────────────────────────────────────

// An unknown role string must throw AgentError (Parse type, ParseEventError code).
TEST(HttpAgentTest, RoleFromStringUnknownRoleThrows) {
    try {
        Message::roleFromString("invalid_role");
        FAIL() << "Expected AgentError to be thrown for unknown role";
    } catch (const AgentError& e) {
        EXPECT_EQ(e.type(), ErrorType::Parse);
        EXPECT_EQ(e.code(), ErrorCode::ParseEventError);
        EXPECT_NE(e.message().find("invalid_role"), std::string::npos);
    }
}

// ── T-3: HTTP 4xx/5xx error response handling ─────────────────────────────────

// HTTP 500 response must invoke onError (not onSuccess).
TEST(HttpAgentTest, RunAgentCallsOnErrorOnHttp500) {
    auto mock = std::make_unique<MockHttpService>();
    mock->simulateHttpError = true;
    mock->httpErrorStatusCode = 500;

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) { successCalled = true; },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("500"), std::string::npos);
}

// HTTP 404 response must invoke onError (not onSuccess).
TEST(HttpAgentTest, RunAgentCallsOnErrorOnHttp404) {
    auto mock = std::make_unique<MockHttpService>();
    mock->simulateHttpError = true;
    mock->httpErrorStatusCode = 404;

    auto agent = makeAgentWithMock(std::move(mock));

    bool successCalled = false;
    bool errorCalled = false;
    std::string capturedError;

    agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) { successCalled = true; },
        [&](const std::string& error) {
            errorCalled = true;
            capturedError = error;
        });

    EXPECT_FALSE(successCalled);
    EXPECT_TRUE(errorCalled);
    EXPECT_NE(capturedError.find("404"), std::string::npos);
}

// Middleware notifyError must be called when HTTP 4xx/5xx is received.
TEST(HttpAgentTest, RunAgentNotifiesMiddlewareOnHttpError) {
    auto mock = std::make_unique<MockHttpService>();
    mock->simulateHttpError = true;
    mock->httpErrorStatusCode = 503;

    auto agent = makeAgentWithMock(std::move(mock));

    // Use the ErrorCapturingMiddleware pattern inline
    class ErrorCapturingMW : public IMiddleware {
    public:
        int errorCount = 0;
        std::unique_ptr<AgentError> onError(std::unique_ptr<AgentError> error,
                                            MiddlewareContext&) override {
            errorCount++;
            return error;
        }
    };

    auto errorMW = std::make_shared<ErrorCapturingMW>();
    agent->use(errorMW);

    agent->runAgent(
        RunAgentParams(),
        [&](const RunAgentResult&) {},
        [&](const std::string&) {});

    EXPECT_EQ(errorMW->errorCount, 1);
}
