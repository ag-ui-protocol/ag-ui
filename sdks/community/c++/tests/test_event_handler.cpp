#include "core/subscriber.h"
#include "core/event.h"
#include "core/session_types.h"
#include <cassert>
#include <iostream>
#include <memory>
#include <string>

using namespace agui;

// Simple test framework
int g_test_count = 0;
int g_test_passed = 0;
int g_test_failed = 0;

#define TEST_CASE(name) \
    void test_##name(); \
    struct TestRegistrar_##name { \
        TestRegistrar_##name() { \
            std::cout << "Running test: " << #name << std::endl; \
            g_test_count++; \
            try { \
                test_##name(); \
                g_test_passed++; \
                std::cout << "   PASSED" << std::endl; \
            } catch (const std::exception& e) { \
                g_test_failed++; \
                std::cout << "   FAILED: " << e.what() << std::endl; \
            } catch (...) { \
                g_test_failed++; \
                std::cout << "   FAILED: Unknown exception" << std::endl; \
            } \
        } \
    } g_test_registrar_##name; \
    void test_##name()

#define ASSERT_TRUE(condition) \
    if (!(condition)) { \
        throw std::runtime_error("Assertion failed: " #condition); \
    }

#define ASSERT_FALSE(condition) \
    if (condition) { \
        throw std::runtime_error("Assertion failed: !" #condition); \
    }

#define EXPECT_EQ(a, b) \
    if ((a) != (b)) { \
        throw std::runtime_error(std::string("Expected equal: ") + #a + " != " + #b); \
    }

// Mock Subscriber for testing
class MockSubscriber : public IAgentSubscriber {
public:
    int onEventCallCount = 0;
    int onTextMessageStartCallCount = 0;
    int onTextMessageContentCallCount = 0;
    int onTextMessageEndCallCount = 0;
    int onToolCallStartCallCount = 0;
    int onToolCallArgsCallCount = 0;
    int onToolCallEndCallCount = 0;
    int onStateDeltaCallCount = 0;
    int onStateSnapshotCallCount = 0;
    int onMessagesChangedCallCount = 0;
    int onStateChangedCallCount = 0;
    int onNewMessageCallCount = 0;
    int onNewToolCallCallCount = 0;
    
    std::string lastTextBuffer;
    std::string lastToolCallArgsBuffer;
    bool shouldStopPropagation = false;
    bool stopInGenericCallback = false;
    
    AgentStateMutation onEvent(const Event& event, const AgentSubscriberParams& params) override {
        onEventCallCount++;
        if (stopInGenericCallback) {
            return AgentStateMutation().withStopPropagation(true);
        }
        return AgentStateMutation();
    }
    
    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                         const AgentSubscriberParams& params) override {
        onTextMessageStartCallCount++;
        return AgentStateMutation().withStopPropagation(shouldStopPropagation);
    }
    
    AgentStateMutation onTextMessageContent(const TextMessageContentEvent& event,
                                           const std::string& buffer,
                                           const AgentSubscriberParams& params) override {
        onTextMessageContentCallCount++;
        lastTextBuffer = buffer;
        return AgentStateMutation();
    }
    
    AgentStateMutation onTextMessageEnd(const TextMessageEndEvent& event,
                                       const AgentSubscriberParams& params) override {
        onTextMessageEndCallCount++;
        return AgentStateMutation();
    }
    
    AgentStateMutation onToolCallStart(const ToolCallStartEvent& event,
                                      const AgentSubscriberParams& params) override {
        onToolCallStartCallCount++;
        return AgentStateMutation();
    }
    
    AgentStateMutation onToolCallArgs(const ToolCallArgsEvent& event,
                                     const std::string& buffer,
                                     const AgentSubscriberParams& params) override {
        onToolCallArgsCallCount++;
        lastToolCallArgsBuffer = buffer;
        return AgentStateMutation();
    }
    
    AgentStateMutation onToolCallEnd(const ToolCallEndEvent& event,
                                    const AgentSubscriberParams& params) override {
        onToolCallEndCallCount++;
        return AgentStateMutation();
    }
    
    AgentStateMutation onStateDelta(const StateDeltaEvent& event,
                                   const AgentSubscriberParams& params) override {
        onStateDeltaCallCount++;
        return AgentStateMutation();
    }
    
    AgentStateMutation onStateSnapshot(const StateSnapshotEvent& event,
                                      const AgentSubscriberParams& params) override {
        onStateSnapshotCallCount++;
        return AgentStateMutation();
    }
    
    void onMessagesChanged(const AgentSubscriberParams& params) override {
        onMessagesChangedCallCount++;
    }
    
    void onStateChanged(const AgentSubscriberParams& params) override {
        onStateChangedCallCount++;
    }
    
    void onNewMessage(const Message& message, const AgentSubscriberParams& params) override {
        onNewMessageCallCount++;
    }
    
    void onNewToolCall(const ToolCall& toolCall, const AgentSubscriberParams& params) override {
        onNewToolCallCallCount++;
    }
    
    void reset() {
        onEventCallCount = 0;
        onTextMessageStartCallCount = 0;
        onTextMessageContentCallCount = 0;
        onTextMessageEndCallCount = 0;
        onToolCallStartCallCount = 0;
        onToolCallArgsCallCount = 0;
        onToolCallEndCallCount = 0;
        onStateDeltaCallCount = 0;
        onStateSnapshotCallCount = 0;
        onMessagesChangedCallCount = 0;
        onStateChangedCallCount = 0;
        onNewMessageCallCount = 0;
        onNewToolCallCallCount = 0;
        lastTextBuffer.clear();
        lastToolCallArgsBuffer.clear();
        shouldStopPropagation = false;
        stopInGenericCallback = false;
    }
};

// ============================================================================
// Event Dispatch Tests
// ============================================================================

TEST_CASE(EventDispatchToCorrectHandler) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Test TEXT_MESSAGE_START dispatch
    auto startEvent = std::make_unique<TextMessageStartEvent>();
    startEvent->messageId = "msg1";
    handler.handleEvent(std::move(startEvent));
    
    EXPECT_EQ(subscriber->onEventCallCount, 1);
    EXPECT_EQ(subscriber->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber->onNewMessageCallCount, 1);
}

TEST_CASE(GenericOnEventCallback) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // Generic onEvent should be called for all events
    ASSERT_TRUE(subscriber->onEventCallCount > 0);
}

TEST_CASE(SpecificCallbackAfterGeneric) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // Both generic and specific callbacks should be called
    EXPECT_EQ(subscriber->onEventCallCount, 1);
    EXPECT_EQ(subscriber->onTextMessageStartCallCount, 1);
}

// ============================================================================
// stopPropagation Tests
// ============================================================================

TEST_CASE(StopPropagationInGenericCallback) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    subscriber->stopInGenericCallback = true;
    
    EventHandler handler(messages, state, {subscriber});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // Generic callback called, but specific callback should NOT be called
    EXPECT_EQ(subscriber->onEventCallCount, 1);
    EXPECT_EQ(subscriber->onTextMessageStartCallCount, 0);
}

TEST_CASE(StopPropagationInSpecificCallback) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber1 = std::make_shared<MockSubscriber>();
    auto subscriber2 = std::make_shared<MockSubscriber>();
    subscriber1->shouldStopPropagation = true;
    
    EventHandler handler(messages, state, {subscriber1, subscriber2});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // First subscriber stops propagation, second should not be called
    EXPECT_EQ(subscriber1->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber2->onTextMessageStartCallCount, 0);
}

TEST_CASE(StopPropagationPreventsDefaultHandling) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    subscriber->stopInGenericCallback = true;
    
    EventHandler handler(messages, state, {subscriber});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // Default handling should not add message to handler
    EXPECT_EQ(handler.messages().size(), 0);
}

// ============================================================================
// Text Message Buffer Accumulation Tests
// ============================================================================

TEST_CASE(TextMessageBufferAccumulation) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // START event
    auto startEvent = std::make_unique<TextMessageStartEvent>();
    startEvent->messageId = "msg1";
    handler.handleEvent(std::move(startEvent));
    
    // CONTENT event 1
    auto contentEvent1 = std::make_unique<TextMessageContentEvent>();
    contentEvent1->messageId = "msg1";
    contentEvent1->delta = "Hello";
    handler.handleEvent(std::move(contentEvent1));
    
    EXPECT_EQ(subscriber->lastTextBuffer, "Hello");
    
    // CONTENT event 2
    auto contentEvent2 = std::make_unique<TextMessageContentEvent>();
    contentEvent2->messageId = "msg1";
    contentEvent2->delta = " World";
    handler.handleEvent(std::move(contentEvent2));
    
    EXPECT_EQ(subscriber->lastTextBuffer, "Hello World");
    
    // END event
    auto endEvent = std::make_unique<TextMessageEndEvent>();
    endEvent->messageId = "msg1";
    handler.handleEvent(std::move(endEvent));
    
    // Verify message was created and has correct content
    EXPECT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].content(), "Hello World");
}

TEST_CASE(MultipleTextMessageContentEvents) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto startEvent = std::make_unique<TextMessageStartEvent>();
    startEvent->messageId = "msg1";
    handler.handleEvent(std::move(startEvent));
    
    // Multiple CONTENT events
    for (int i = 0; i < 5; i++) {
        auto contentEvent = std::make_unique<TextMessageContentEvent>();
        contentEvent->messageId = "msg1";
        contentEvent->delta = std::to_string(i);
        handler.handleEvent(std::move(contentEvent));
    }
    
    EXPECT_EQ(subscriber->lastTextBuffer, "01234");
}

TEST_CASE(TextBufferClearedOnEnd) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Complete message flow
    auto startEvent = std::make_unique<TextMessageStartEvent>();
    startEvent->messageId = "msg1";
    handler.handleEvent(std::move(startEvent));
    
    auto contentEvent = std::make_unique<TextMessageContentEvent>();
    contentEvent->messageId = "msg1";
    contentEvent->delta = "Test";
    handler.handleEvent(std::move(contentEvent));
    
    auto endEvent = std::make_unique<TextMessageEndEvent>();
    endEvent->messageId = "msg1";
    handler.handleEvent(std::move(endEvent));
    
    // Start a new message - buffer should be empty
    subscriber->reset();
    auto startEvent2 = std::make_unique<TextMessageStartEvent>();
    startEvent2->messageId = "msg2";
    handler.handleEvent(std::move(startEvent2));
    
    auto contentEvent2 = std::make_unique<TextMessageContentEvent>();
    contentEvent2->messageId = "msg2";
    contentEvent2->delta = "New";
    handler.handleEvent(std::move(contentEvent2));
    
    // Buffer should only contain new message content
    EXPECT_EQ(subscriber->lastTextBuffer, "New");
}

TEST_CASE(TextBufferPassedToSubscriber) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto startEvent = std::make_unique<TextMessageStartEvent>();
    startEvent->messageId = "msg1";
    handler.handleEvent(std::move(startEvent));
    
    auto contentEvent = std::make_unique<TextMessageContentEvent>();
    contentEvent->messageId = "msg1";
    contentEvent->delta = "Buffer Test";
    handler.handleEvent(std::move(contentEvent));
    
    // Subscriber should receive accumulated buffer
    EXPECT_EQ(subscriber->lastTextBuffer, "Buffer Test");
    EXPECT_EQ(subscriber->onTextMessageContentCallCount, 1);
}

// ============================================================================
// Tool Call Args Buffer Accumulation Tests
// ============================================================================

TEST_CASE(ToolCallArgsBufferAccumulation) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // START event
    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->parentMessageId = "msg1";
    startEvent->toolCallId = "call1";
    startEvent->toolCallName = "search";
    handler.handleEvent(std::move(startEvent));
    
    // ARGS event 1
    auto argsEvent1 = std::make_unique<ToolCallArgsEvent>();
    argsEvent1->messageId = "msg1";
    argsEvent1->toolCallId = "call1";
    argsEvent1->delta = "{\"query\":";
    handler.handleEvent(std::move(argsEvent1));
    
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"query\":");
    
    // ARGS event 2
    auto argsEvent2 = std::make_unique<ToolCallArgsEvent>();
    argsEvent2->messageId = "msg1";
    argsEvent2->toolCallId = "call1";
    argsEvent2->delta = "\"test\"}";
    handler.handleEvent(std::move(argsEvent2));
    
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"query\":\"test\"}");
    
    // END event
    auto endEvent = std::make_unique<ToolCallEndEvent>();
    endEvent->toolCallId = "call1";
    handler.handleEvent(std::move(endEvent));
    
    // Verify tool call was created with correct args
    EXPECT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].toolCalls().size(), 1);
    EXPECT_EQ(handler.messages()[0].toolCalls()[0].function.arguments, "{\"query\":\"test\"}");
}

TEST_CASE(MultipleToolCallArgsEvents) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->parentMessageId = "msg1";
    startEvent->toolCallId = "call1";
    startEvent->toolCallName = "test";
    handler.handleEvent(std::move(startEvent));
    
    // Multiple ARGS events
    std::string parts[] = {"{", "\"a\"", ":", "1", "}"};
    for (const auto& part : parts) {
        auto argsEvent = std::make_unique<ToolCallArgsEvent>();
        argsEvent->messageId = "msg1";
        argsEvent->toolCallId = "call1";
        argsEvent->delta = part;
        handler.handleEvent(std::move(argsEvent));
    }
    
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"a\":1}");
}

TEST_CASE(ToolCallArgsBufferClearedOnEnd) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // First tool call
    auto startEvent1 = std::make_unique<ToolCallStartEvent>();
    startEvent1->parentMessageId = "msg1";
    startEvent1->toolCallId = "call1";
    startEvent1->toolCallName = "test1";
    handler.handleEvent(std::move(startEvent1));
    
    auto argsEvent1 = std::make_unique<ToolCallArgsEvent>();
    argsEvent1->messageId = "msg1";
    argsEvent1->toolCallId = "call1";
    argsEvent1->delta = "{\"a\":1}";
    handler.handleEvent(std::move(argsEvent1));
    
    auto endEvent1 = std::make_unique<ToolCallEndEvent>();
    endEvent1->toolCallId = "call1";
    handler.handleEvent(std::move(endEvent1));
    
    // Second tool call - buffer should be independent
    subscriber->reset();
    auto startEvent2 = std::make_unique<ToolCallStartEvent>();
    startEvent2->parentMessageId = "msg1";
    startEvent2->toolCallId = "call2";
    startEvent2->toolCallName = "test2";
    handler.handleEvent(std::move(startEvent2));
    
    auto argsEvent2 = std::make_unique<ToolCallArgsEvent>();
    argsEvent2->messageId = "msg1";
    argsEvent2->toolCallId = "call2";
    argsEvent2->delta = "{\"b\":2}";
    handler.handleEvent(std::move(argsEvent2));
    
    // Buffer should only contain second tool call args
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"b\":2}");
}

TEST_CASE(ToolCallArgsPassedToSubscriber) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->parentMessageId = "msg1";
    startEvent->toolCallId = "call1";
    startEvent->toolCallName = "test";
    handler.handleEvent(std::move(startEvent));
    
    auto argsEvent = std::make_unique<ToolCallArgsEvent>();
    argsEvent->messageId = "msg1";
    argsEvent->toolCallId = "call1";
    argsEvent->delta = "{\"test\":true}";
    handler.handleEvent(std::move(argsEvent));
    
    // Subscriber should receive accumulated buffer
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"test\":true}");
    EXPECT_EQ(subscriber->onToolCallArgsCallCount, 1);
}

// ============================================================================
// State Delta (JSON Patch) Tests
// ============================================================================

TEST_CASE(StateDeltaAppliesJsonPatch) {
    std::vector<Message> messages;
    std::string state = "{\"count\":0}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Apply JSON Patch to increment count
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/count"},
        {"value", 1}
    });
    
    auto deltaEvent = std::make_unique<StateDeltaEvent>();
    deltaEvent->delta = patch;
    handler.handleEvent(std::move(deltaEvent));
    
    // Verify state was updated
    nlohmann::json updatedState = nlohmann::json::parse(handler.state());
    EXPECT_EQ(updatedState["count"], 1);
}

TEST_CASE(StateDeltaNotifiesSubscribers) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/newField"},
        {"value", "test"}
    });
    
    auto deltaEvent = std::make_unique<StateDeltaEvent>();
    deltaEvent->delta = patch;
    handler.handleEvent(std::move(deltaEvent));
    
    // Subscriber should be notified
    EXPECT_EQ(subscriber->onStateDeltaCallCount, 1);
    EXPECT_EQ(subscriber->onStateChangedCallCount, 1);
}

TEST_CASE(StateSnapshotReplacesState) {
    std::vector<Message> messages;
    std::string state = "{\"old\":\"value\"}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    nlohmann::json newState = {{"new", "state"}};
    
    auto snapshotEvent = std::make_unique<StateSnapshotEvent>();
    snapshotEvent->snapshot = newState;
    handler.handleEvent(std::move(snapshotEvent));
    
    // Verify state was completely replaced
    nlohmann::json currentState = nlohmann::json::parse(handler.state());
    ASSERT_FALSE(currentState.contains("old"));
    ASSERT_TRUE(currentState.contains("new"));
    EXPECT_EQ(currentState["new"], "state");
}

// ============================================================================
// Subscriber Management Tests
// ============================================================================

TEST_CASE(AddRemoveSubscribers) {
    std::vector<Message> messages;
    std::string state = "{}";
    
    EventHandler handler(messages, state);
    
    auto subscriber1 = std::make_shared<MockSubscriber>();
    auto subscriber2 = std::make_shared<MockSubscriber>();
    
    handler.addSubscriber(subscriber1);
    handler.addSubscriber(subscriber2);
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    EXPECT_EQ(subscriber1->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber2->onTextMessageStartCallCount, 1);
    
    // Remove one subscriber
    handler.removeSubscriber(subscriber1);
    
    auto event2 = std::make_unique<TextMessageStartEvent>();
    event2->messageId = "msg2";
    handler.handleEvent(std::move(event2));
    
    // Only subscriber2 should be notified
    EXPECT_EQ(subscriber1->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber2->onTextMessageStartCallCount, 2);
}

TEST_CASE(ClearAllSubscribers) {
    std::vector<Message> messages;
    std::string state = "{}";
    
    auto subscriber1 = std::make_shared<MockSubscriber>();
    auto subscriber2 = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber1, subscriber2});
    
    handler.clearSubscribers();
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // No subscribers should be notified
    EXPECT_EQ(subscriber1->onTextMessageStartCallCount, 0);
    EXPECT_EQ(subscriber2->onTextMessageStartCallCount, 0);
}

TEST_CASE(MultipleSubscribersNotification) {
    std::vector<Message> messages;
    std::string state = "{}";
    
    auto subscriber1 = std::make_shared<MockSubscriber>();
    auto subscriber2 = std::make_shared<MockSubscriber>();
    auto subscriber3 = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber1, subscriber2, subscriber3});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // All subscribers should be notified
    EXPECT_EQ(subscriber1->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber2->onTextMessageStartCallCount, 1);
    EXPECT_EQ(subscriber3->onTextMessageStartCallCount, 1);
}

// ============================================================================
// Main function
// ============================================================================

int main() {
    std::cout << "\n========================================" << std::endl;
    std::cout << "EventHandler Test Suite" << std::endl;
    std::cout << "========================================\n" << std::endl;
    
    // Tests will run automatically when global objects are initialized
    
    std::cout << "\n========================================" << std::endl;
    std::cout << "Test Results:" << std::endl;
    std::cout << "  Total:  " << g_test_count << std::endl;
    std::cout << "  Passed: " << g_test_passed << std::endl;
    std::cout << "  Failed: " << g_test_failed << std::endl;
    std::cout << "========================================" << std::endl;
    
    return g_test_failed > 0 ? 1 : 0;
}