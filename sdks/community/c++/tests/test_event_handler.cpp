/**
 * @file test_event_handler.cpp
 * @brief EventHandler functionality tests
 * 
 * Tests event dispatch, buffer accumulation, state management and subscriber management
 */

#include <gtest/gtest.h>
#include <memory>
#include <string>

#include "core/subscriber.h"
#include "core/event.h"
#include "core/session_types.h"

using namespace agui;

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
    int onToolCallResultCallCount = 0;
    int onStateDeltaCallCount = 0;
    int onStateSnapshotCallCount = 0;
    int onMessagesChangedCallCount = 0;
    int onStateChangedCallCount = 0;
    int onNewMessageCallCount = 0;
    int onNewToolCallCallCount = 0;
    
    std::string lastTextBuffer;
    std::string lastToolCallArgsBuffer;
    std::string lastToolCallResult;
    bool shouldStopPropagation = false;
    bool stopInGenericCallback = false;
    
    AgentStateMutation onEvent(const Event& event, const AgentSubscriberParams& params) override {
        onEventCallCount++;
        if (stopInGenericCallback) {
            AgentStateMutation mutation;
            mutation.stopPropagation = true;
            return mutation;
        }
        return AgentStateMutation();
    }
    
    AgentStateMutation onTextMessageStart(const TextMessageStartEvent& event,
                                         const AgentSubscriberParams& params) override {
        onTextMessageStartCallCount++;
        AgentStateMutation mutation;
        mutation.stopPropagation = shouldStopPropagation;
        return mutation;
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
    
    AgentStateMutation onToolCallResult(const ToolCallResultEvent& event,
                                       const AgentSubscriberParams& params) override {
        onToolCallResultCallCount++;
        lastToolCallResult = event.result;
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
};

// Event Dispatch Tests
TEST(EventHandlerTest, EventDispatchToCorrectHandler) {
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

// stopPropagation Tests
TEST(EventHandlerTest, StopPropagationInGenericCallback) {
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

TEST(EventHandlerTest, StopPropagationInSpecificCallback) {
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

TEST(EventHandlerTest, AddRemoveSubscribers) {
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

TEST(EventHandlerTest, ClearAllSubscribers) {
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

TEST(EventHandlerTest, MultipleSubscribersNotification) {
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


TEST(EventHandlerTest, StopPropagationPreventsDefaultHandling) {
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

// Text Message Buffer Accumulation Tests
TEST(EventHandlerTest, TextMessageBufferAccumulation) {
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

TEST(EventHandlerTest, MultipleTextMessageContentEvents) {
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

TEST(EventHandlerTest, TextBufferClearedOnEnd) {
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

TEST(EventHandlerTest, TextBufferPassedToSubscriber) {
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

// Tool Call Args Buffer Accumulation Tests
TEST(EventHandlerTest, ToolCallArgsBufferAccumulation) {
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

TEST(EventHandlerTest, MultipleToolCallArgsEvents) {
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

TEST(EventHandlerTest, ToolCallArgsBufferClearedOnEnd) {
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

// State Delta (JSON Patch) Tests
TEST(EventHandlerTest, StateDeltaAppliesJsonPatch) {
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

TEST(EventHandlerTest, StateDeltaNotifiesSubscribers) {
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

TEST(EventHandlerTest, StateSnapshotReplacesState) {
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

// ToolCallResultEvent Tests
TEST(EventHandlerTest, ToolCallResultEventTriggersCallback) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Setup: Complete tool call flow (START -> ARGS -> END)
    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->parentMessageId = "msg1";
    startEvent->toolCallId = "call1";
    startEvent->toolCallName = "search";
    handler.handleEvent(std::move(startEvent));
    
    auto argsEvent = std::make_unique<ToolCallArgsEvent>();
    argsEvent->messageId = "msg1";
    argsEvent->toolCallId = "call1";
    argsEvent->delta = "{\"query\":\"test\"}";
    handler.handleEvent(std::move(argsEvent));
    
    auto endEvent = std::make_unique<ToolCallEndEvent>();
    endEvent->toolCallId = "call1";
    handler.handleEvent(std::move(endEvent));
    
    // Test: Send ToolCallResultEvent
    auto resultEvent = std::make_unique<ToolCallResultEvent>();
    resultEvent->toolCallId = "call1";
    resultEvent->result = "{\"status\":\"success\",\"data\":\"found\"}";
    handler.handleEvent(std::move(resultEvent));
    
    // Verify: onToolCallResult callback was triggered
    EXPECT_EQ(subscriber->onToolCallResultCallCount, 1);
    EXPECT_EQ(subscriber->lastToolCallResult, "{\"status\":\"success\",\"data\":\"found\"}");
}

TEST(EventHandlerTest, ToolCallResultEventWithMultipleResults) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Setup: Create two tool calls
    auto startEvent1 = std::make_unique<ToolCallStartEvent>();
    startEvent1->parentMessageId = "msg1";
    startEvent1->toolCallId = "call1";
    startEvent1->toolCallName = "tool1";
    handler.handleEvent(std::move(startEvent1));
    
    auto argsEvent1 = std::make_unique<ToolCallArgsEvent>();
    argsEvent1->messageId = "msg1";
    argsEvent1->toolCallId = "call1";
    argsEvent1->delta = "{\"param\":\"value1\"}";
    handler.handleEvent(std::move(argsEvent1));
    
    auto endEvent1 = std::make_unique<ToolCallEndEvent>();
    endEvent1->toolCallId = "call1";
    handler.handleEvent(std::move(endEvent1));
    
    auto startEvent2 = std::make_unique<ToolCallStartEvent>();
    startEvent2->parentMessageId = "msg1";
    startEvent2->toolCallId = "call2";
    startEvent2->toolCallName = "tool2";
    handler.handleEvent(std::move(startEvent2));
    
    auto argsEvent2 = std::make_unique<ToolCallArgsEvent>();
    argsEvent2->messageId = "msg1";
    argsEvent2->toolCallId = "call2";
    argsEvent2->delta = "{\"param\":\"value2\"}";
    handler.handleEvent(std::move(argsEvent2));
    
    auto endEvent2 = std::make_unique<ToolCallEndEvent>();
    endEvent2->toolCallId = "call2";
    handler.handleEvent(std::move(endEvent2));
    
    // Test: Send ToolCallResultEvents for both tool calls
    auto resultEvent1 = std::make_unique<ToolCallResultEvent>();
    resultEvent1->toolCallId = "call1";
    resultEvent1->result = "result1";
    handler.handleEvent(std::move(resultEvent1));
    
    auto resultEvent2 = std::make_unique<ToolCallResultEvent>();
    resultEvent2->toolCallId = "call2";
    resultEvent2->result = "result2";
    handler.handleEvent(std::move(resultEvent2));
    
    // Verify: Both tool result messages were created
    EXPECT_EQ(handler.messages().size(), 3); // 1 assistant + 2 tool results
    EXPECT_EQ(subscriber->onToolCallResultCallCount, 2);
    EXPECT_EQ(handler.messages()[1].content(), "result1");
    EXPECT_EQ(handler.messages()[2].content(), "result2");
}

// MessagesSnapshotEvent Tests
TEST(EventHandlerTest, MessagesSnapshotReplacesMessages) {
    std::vector<Message> messages;
    std::string state = "{}";
    auto subscriber = std::make_shared<MockSubscriber>();
    
    // Add some initial messages
    messages.push_back(Message::createUserWithId("msg1", "Hello"));
    messages.push_back(Message::createAssistantWithId("msg2", "Hi there"));
    
    EventHandler handler(messages, state, {subscriber});
    EXPECT_EQ(handler.messages().size(), 2);
    
    // Create new messages for snapshot
    std::vector<Message> newMessages;
    newMessages.push_back(Message::createUserWithId("new1", "New message"));
    newMessages.push_back(Message::createAssistantWithId("msg2", "Second"));
    
    // Test: Send MessagesSnapshotEvent
    auto snapshotEvent = std::make_unique<MessagesSnapshotEvent>();
    snapshotEvent->messages = newMessages;
    handler.handleEvent(std::move(snapshotEvent));
    
    // Verify: Messages were completely replaced
    EXPECT_EQ(handler.messages().size(), 2);
    EXPECT_EQ(handler.messages()[0].id(), "new1");
    EXPECT_EQ(handler.messages()[0].content(), "New message");
    
    EXPECT_EQ(handler.messages()[1].id(), "msg2");
    EXPECT_EQ(handler.messages()[1].content(), "Second");
    
    // Verify: Subscriber was notified
    EXPECT_EQ(subscriber->onEventCallCount, 1);
    EXPECT_EQ(subscriber->onMessagesChangedCallCount, 1);
}
