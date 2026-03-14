/**
 * @file test_http_agent.cpp
 * @brief HttpAgent end-to-end tests
 * 
 * Tests HttpAgent building, running, state management and subscriber management
 */

#include <gtest/gtest.h>
#include <memory>
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
    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                          const AgentSubscriberParams& params) override {
        textMessageStartCount++;
        return AgentStateMutation();
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

    std::string initialState = R"({
        "counter": 0,
        "status": "ready"
    })";

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
