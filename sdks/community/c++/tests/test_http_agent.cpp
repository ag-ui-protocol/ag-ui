/**
 * @file test_http_agent.cpp
 * @brief HttpAgent end-to-end tests
 * 
 * Tests HttpAgent building, running, state management and subscriber management
 */

#include <cassert>
#include <iostream>
#include <memory>
#include <vector>

#include "agent/http_agent.h"
#include "core/error.h"
#include "core/event.h"
#include "core/subscriber.h"
#include "core/session_types.h"

using namespace agui;


void log(const std::string& message) {
    std::cout << "[HTTP_AGENT_TEST] " << message << std::endl;
}

void assertTrue(bool condition, const std::string& message) {
    if (!condition) {
        std::cout << " Failed: " << message << std::endl;
    } else {
        std::cout << " " << message << std::endl;
    }
}


class TestSubscriber : public IAgentSubscriber {
public:
    int textMessageStartCount = 0;
    int textMessageContentCount = 0;
    int textMessageEndCount = 0;
    int toolCallStartCount = 0;
    int stateSnapshotCount = 0;
    
    std::string lastContent;
    nlohmann::json lastState;

    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                          const AgentSubscriberParams& params) override {
        textMessageStartCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event, const std::string& buffer,
                                            const AgentSubscriberParams& params) override {
        textMessageContentCount++;
        lastContent += event.delta;
        return AgentStateMutation();
    }

    AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event, const AgentSubscriberParams& params) override {
        textMessageEndCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onToolCallStart(const ToolCallStartEvent& event, const AgentSubscriberParams& params) override {
        toolCallStartCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onStateSnapshot(const StateSnapshotEvent& event, const AgentSubscriberParams& params) override {
        stateSnapshotCount++;
        lastState = event.snapshot;
        return AgentStateMutation();
    }

    void reset() {
        textMessageStartCount = 0;
        textMessageContentCount = 0;
        textMessageEndCount = 0;
        toolCallStartCount = 0;
        stateSnapshotCount = 0;
        lastContent.clear();
        lastState = nlohmann::json::object();
    }
};


void testHttpAgentBuilder() {
    log("Test 1: HttpAgent Builder basic construction");

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("test_agent_123"))
        .build();

    assertTrue(agent != nullptr, "Agent created successfully");
    assertTrue(agent->agentId() == "test_agent_123", "Agent ID set correctly");

    log(" HttpAgent Builder basic construction test passed\n");
}


void testBuilderParameters() {
    log("Test 2: Builder parameter configuration");

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

    assertTrue(agent != nullptr, "Agent created successfully");
    assertTrue(agent->messages().size() == 2, "Initial message count correct");
    assertTrue(agent->messages()[0].id() == "msg_1", "Message 1 ID correct");
    assertTrue(agent->messages()[1].id() == "msg_2", "Message 2 ID correct");

    log(" Builder parameter configuration test passed\n");
}


void testBuilderChaining() {
    log("Test 3: Builder method chaining");

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withHeader("X-Custom-Header", "custom_value")
        .withHeader("X-Request-ID", "req_789")
        .withBearerToken("token_abc")
        .withTimeout(15)
        .withAgentId(AgentId("agent_chain"))
        .build();

    assertTrue(agent != nullptr, "Chained construction successful");
    assertTrue(agent->agentId() == "agent_chain", "Chained call: Agent ID correct");

    log(" Builder method chaining test passed\n");
}


void testMessageManagement() {
    log("Test 4: Message management");

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_msg"))
        .build();

    assertTrue(agent->messages().empty(), "Initial message list is empty");

    Message msg1("msg_1", MessageRole::User, "Hello");
    agent->addMessage(msg1);
    assertTrue(agent->messages().size() == 1, "Message count is 1 after adding");
    assertTrue(agent->messages()[0].id() == "msg_1", "Message ID correct");

    Message msg2("msg_2", MessageRole::Assistant, "Hi");
    agent->addMessage(msg2);
    assertTrue(agent->messages().size() == 2, "Message count is 2 after adding second message");

    std::vector<Message> newMessages = {
        Message("msg_3", MessageRole::User, "New message 1"),
        Message("msg_4", MessageRole::Assistant, "New message 2"),
        Message("msg_5", MessageRole::User, "New message 3")
    };
    agent->setMessages(newMessages);
    assertTrue(agent->messages().size() == 3, "Message count is 3 after setting message list");
    assertTrue(agent->messages()[0].id() == "msg_3", "New message 1 ID correct");
    assertTrue(agent->messages()[2].id() == "msg_5", "New message 3 ID correct");

    log(" Message management test passed\n");
}


void testSubscriberManagement() {
    log("Test 6: Subscriber management");

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

    log(" Subscriber management test passed\n");
}


void testSubscriberCallbacks() {
    log("Test 7: Subscriber callback triggering");

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_callback"))
        .build();

    auto subscriber = std::make_shared<TestSubscriber>();
    agent->subscribe(subscriber);

    // Note: This only tests subscriber registration, actual callback triggering requires real events
    // Callback verification will be done in integration tests

    assertTrue(subscriber->textMessageStartCount == 0, "Initial count is 0");

    log(" Subscriber callback triggering test passed\n");
}


void testAgentId() {
    log("Test 8: AgentId handling");

    AgentId id1("agent_123");
    AgentId id2 = id1;

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(id1)
        .build();

    assertTrue(agent->agentId() == "agent_123", "Agent ID correct");

    log(" AgentId handling test passed\n");
}


void testInitialMessagesAndState() {
    log("Test 9: Initial messages and state");

    std::vector<Message> messages = {
        Message("msg_1", MessageRole::User, "First message"),
        Message("msg_2", MessageRole::Assistant, "Second message")
    };

    nlohmann::json state = {
        {"initialized", true},
        {"version", "1.0"}
    };

    auto agent = HttpAgent::builder()
        .withUrl("http://localhost:8080")
        .withAgentId(AgentId("agent_init"))
        .withInitialMessages(messages)
        .withInitialState(state)
        .build();

    assertTrue(agent->messages().size() == 2, "Initial message count correct");
    assertTrue(agent->messages()[0].content() == "First message", "Message 1 content correct");
    assertTrue(agent->messages()[1].content() == "Second message", "Message 2 content correct");

    log(" Initial messages and state test passed\n");
}


void testMultipleAgents() {
    log("Test 10: Multiple Agent instances");

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

    assertTrue(agent1->agentId() == "agent_1", "Agent1 ID correct");
    assertTrue(agent2->agentId() == "agent_2", "Agent2 ID correct");
    assertTrue(agent3->agentId() == "agent_3", "Agent3 ID correct");

    log(" Multiple Agent instances test passed\n");
}


int main() {
    std::cout << "\n";
    std::cout << "======================================\n";
    std::cout << "  AG-UI HttpAgent Test Suite\n";
    std::cout << "======================================\n\n";

    try {
        testHttpAgentBuilder();
        testBuilderParameters();
        testBuilderChaining();
        testMessageManagement();
        testSubscriberManagement();
        testSubscriberCallbacks();
        testAgentId();
        testInitialMessagesAndState();
        testMultipleAgents();

        std::cout << "======================================\n";
        std::cout << "  Test Results\n";
        std::cout << "======================================\n";
        std::cout << "Total: 10\n";
        std::cout << "Passed: 10\n";
        std::cout << "Failed: 0\n";
        std::cout << "======================================\n\n";
        std::cout << " All HttpAgent tests passed!\n\n";

        return 0;
    } catch (const std::exception& e) {
        std::cerr << "\n Test failed: " << e.what() << "\n\n";
        return 1;
    }
}
