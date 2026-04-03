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
    int onTextMessageChunkCallCount = 0;
    int onToolCallStartCallCount = 0;
    int onToolCallArgsCallCount = 0;
    int onToolCallEndCallCount = 0;
    int onToolCallChunkCallCount = 0;
    int onToolCallResultCallCount = 0;
    int onStateDeltaCallCount = 0;
    int onStateSnapshotCallCount = 0;
    int onActivitySnapshotCallCount = 0;
    int onActivityDeltaCallCount = 0;
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

    AgentStateMutation onTextMessageChunk(const TextMessageChunkEvent& event,
                                          const AgentSubscriberParams& params) override {
        onTextMessageChunkCallCount++;
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

    AgentStateMutation onToolCallChunk(const ToolCallChunkEvent& event,
                                       const AgentSubscriberParams& params) override {
        onToolCallChunkCallCount++;
        return AgentStateMutation();
    }
    
    AgentStateMutation onToolCallResult(const ToolCallResultEvent& event,
                                       const AgentSubscriberParams& params) override {
        onToolCallResultCallCount++;
        lastToolCallResult = event.content;
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

    AgentStateMutation onActivitySnapshot(const ActivitySnapshotEvent& event,
                                          const AgentSubscriberParams& params) override {
        onActivitySnapshotCallCount++;
        return AgentStateMutation();
    }

    AgentStateMutation onActivityDelta(const ActivityDeltaEvent& event,
                                       const AgentSubscriberParams& params) override {
        onActivityDeltaCallCount++;
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

class MutationSubscriber : public IAgentSubscriber {
public:
    nlohmann::json genericStateMutation;
    nlohmann::json specificStateMutation;
    std::optional<std::vector<Message>> genericMessagesMutation;
    std::optional<std::vector<Message>> specificMessagesMutation;

    AgentStateMutation onEvent(const Event&, const AgentSubscriberParams&) override {
        AgentStateMutation mutation;
        if (!genericStateMutation.is_null()) {
            mutation.withState(genericStateMutation);
        }
        if (genericMessagesMutation.has_value()) {
            mutation.withMessages(genericMessagesMutation.value());
        }
        return mutation;
    }

    AgentStateMutation onTextMessageStart(const TextMessageStartEvent&,
                                          const AgentSubscriberParams&) override {
        AgentStateMutation mutation;
        if (!specificStateMutation.is_null()) {
            mutation.withState(specificStateMutation);
        }
        if (specificMessagesMutation.has_value()) {
            mutation.withMessages(specificMessagesMutation.value());
        }
        return mutation;
    }
};

// Event Dispatch Tests
TEST(EventHandlerTest, EventDispatchToCorrectHandler) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
    
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
    nlohmann::json state = nlohmann::json::object();
    
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
    nlohmann::json state = nlohmann::json::object();
    
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
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    subscriber->stopInGenericCallback = true;
    
    EventHandler handler(messages, state, {subscriber});
    
    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";
    handler.handleEvent(std::move(event));
    
    // Default handling should not add message to handler
    EXPECT_EQ(handler.messages().size(), 0);
}

TEST(EventHandlerTest, GenericOnEventMutationIsReturnedAndApplied) {
    std::vector<Message> messages;
    nlohmann::json state = {{"initial", true}};
    auto subscriber = std::make_shared<MutationSubscriber>();
    subscriber->genericStateMutation = {{"from_generic", 1}};

    EventHandler handler(messages, state, {subscriber});

    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";

    AgentStateMutation mutation = handler.handleEvent(std::move(event));
    ASSERT_TRUE(mutation.state.has_value());

    handler.applyMutation(mutation);

    EXPECT_EQ(handler.state()["from_generic"], 1);
}

TEST(EventHandlerTest, SpecificMutationOverridesGenericMutationForSameField) {
    std::vector<Message> messages;
    nlohmann::json state = {{"initial", true}};
    auto subscriber = std::make_shared<MutationSubscriber>();
    subscriber->genericStateMutation = {{"source", "generic"}};
    subscriber->specificStateMutation = {{"source", "specific"}};

    EventHandler handler(messages, state, {subscriber});

    auto event = std::make_unique<TextMessageStartEvent>();
    event->messageId = "msg1";

    AgentStateMutation mutation = handler.handleEvent(std::move(event));
    ASSERT_TRUE(mutation.state.has_value());

    handler.applyMutation(mutation);

    EXPECT_EQ(handler.state()["source"], "specific");
}

TEST(EventHandlerTest, TextMessageChunkCreatesAndAppendsMessageDirectly) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();

    EventHandler handler(messages, state, {subscriber});

    auto firstChunk = std::make_unique<TextMessageChunkEvent>();
    firstChunk->messageId = "msg1";
    firstChunk->role = MessageRole::Assistant;
    firstChunk->name = "planner";
    firstChunk->delta = "Hello";
    handler.handleEvent(std::move(firstChunk));

    auto secondChunk = std::make_unique<TextMessageChunkEvent>();
    secondChunk->delta = " World";
    handler.handleEvent(std::move(secondChunk));

    ASSERT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].id(), "msg1");
    EXPECT_EQ(handler.messages()[0].content(), "Hello World");
    EXPECT_EQ(handler.messages()[0].name(), "planner");
    EXPECT_EQ(subscriber->onTextMessageChunkCallCount, 2);
}

TEST(EventHandlerTest, ToolCallChunkCreatesAndAppendsToolCallDirectly) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();

    EventHandler handler(messages, state, {subscriber});

    auto firstChunk = std::make_unique<ToolCallChunkEvent>();
    firstChunk->toolCallId = "tool1";
    firstChunk->toolCallName = "search";
    firstChunk->parentMessageId = "msg1";
    firstChunk->delta = "{\"query\":";
    handler.handleEvent(std::move(firstChunk));

    auto secondChunk = std::make_unique<ToolCallChunkEvent>();
    secondChunk->delta = "\"weather\"}";
    handler.handleEvent(std::move(secondChunk));

    ASSERT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].id(), "msg1");
    ASSERT_EQ(handler.messages()[0].toolCalls().size(), 1);
    EXPECT_EQ(handler.messages()[0].toolCalls()[0].id, "tool1");
    EXPECT_EQ(handler.messages()[0].toolCalls()[0].function.name, "search");
    EXPECT_EQ(handler.messages()[0].toolCalls()[0].function.arguments, "{\"query\":\"weather\"}");
    EXPECT_EQ(subscriber->onToolCallChunkCallCount, 2);
}

TEST(EventHandlerTest, TextMessageChunkWithoutContextThrows) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    EventHandler handler(messages, state);

    auto chunk = std::make_unique<TextMessageChunkEvent>();
    chunk->delta = "Hello";

    try {
        handler.handleEvent(std::move(chunk));
        FAIL() << "Expected AgentError";
    } catch (const AgentError& error) {
        EXPECT_EQ(error.type(), ErrorType::Validation);
        EXPECT_EQ(error.code(), ErrorCode::ValidationInvalidEvent);
        EXPECT_NE(error.message().find("TEXT_MESSAGE_CHUNK"), std::string::npos);
    }
}

TEST(EventHandlerTest, ToolCallChunkWithoutToolCallIdContextThrows) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    EventHandler handler(messages, state);

    auto chunk = std::make_unique<ToolCallChunkEvent>();
    chunk->toolCallName = "search";
    chunk->delta = "{}";

    try {
        handler.handleEvent(std::move(chunk));
        FAIL() << "Expected AgentError";
    } catch (const AgentError& error) {
        EXPECT_EQ(error.type(), ErrorType::Validation);
        EXPECT_EQ(error.code(), ErrorCode::ValidationInvalidEvent);
        EXPECT_NE(error.message().find("TOOL_CALL_CHUNK"), std::string::npos);
    }
}

TEST(EventHandlerTest, ToolCallChunkWithoutCreationMetadataThrows) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    EventHandler handler(messages, state);

    auto chunk = std::make_unique<ToolCallChunkEvent>();
    chunk->toolCallId = "tool-1";
    chunk->delta = "{}";

    try {
        handler.handleEvent(std::move(chunk));
        FAIL() << "Expected AgentError";
    } catch (const AgentError& error) {
        EXPECT_EQ(error.type(), ErrorType::Validation);
        EXPECT_EQ(error.code(), ErrorCode::ValidationInvalidEvent);
        EXPECT_NE(error.message().find("toolCallName"), std::string::npos);
    }
}

// Text Message Buffer Accumulation Tests
TEST(EventHandlerTest, TextMessageBufferAccumulation) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    nlohmann::json state = nlohmann::json::object();
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
    argsEvent1->toolCallId = "call1";
    argsEvent1->delta = "{\"query\":";
    handler.handleEvent(std::move(argsEvent1));
    
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"query\":");
    
    // ARGS event 2
    auto argsEvent2 = std::make_unique<ToolCallArgsEvent>();
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
    nlohmann::json state = nlohmann::json::object();
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
        argsEvent->toolCallId = "call1";
        argsEvent->delta = part;
        handler.handleEvent(std::move(argsEvent));
    }
    
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"a\":1}");
}

TEST(EventHandlerTest, ToolCallArgsBufferClearedOnEnd) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // First tool call
    auto startEvent1 = std::make_unique<ToolCallStartEvent>();
    startEvent1->parentMessageId = "msg1";
    startEvent1->toolCallId = "call1";
    startEvent1->toolCallName = "test1";
    handler.handleEvent(std::move(startEvent1));
    
    auto argsEvent1 = std::make_unique<ToolCallArgsEvent>();
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
    argsEvent2->toolCallId = "call2";
    argsEvent2->delta = "{\"b\":2}";
    handler.handleEvent(std::move(argsEvent2));
    
    // Buffer should only contain second tool call args
    EXPECT_EQ(subscriber->lastToolCallArgsBuffer, "{\"b\":2}");
}

// State Delta (JSON Patch) Tests
TEST(EventHandlerTest, StateDeltaAppliesJsonPatch) {
    std::vector<Message> messages;
    nlohmann::json state = {{"count", 10}};
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
    EXPECT_EQ(handler.state()["count"], 1);
}

TEST(EventHandlerTest, StateDeltaNotifiesSubscribers) {
    std::vector<Message> messages;
    nlohmann::json state = {};
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
    nlohmann::json state = {{"old", "value"}};
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    nlohmann::json newState = {{"new", "state"}};
    
    auto snapshotEvent = std::make_unique<StateSnapshotEvent>();
    snapshotEvent->snapshot = newState;
    handler.handleEvent(std::move(snapshotEvent));
    
    // Verify state was completely replaced
    ASSERT_FALSE(handler.state().contains("old"));
    ASSERT_TRUE(handler.state().contains("new"));
    EXPECT_EQ(handler.state()["new"], "state");
}

// ToolCallResultEvent Tests
TEST(EventHandlerTest, ToolCallResultEventTriggersCallback) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Setup: Complete tool call flow (START -> ARGS -> END)
    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->parentMessageId = "msg1";
    startEvent->toolCallId = "call1";
    startEvent->toolCallName = "search";
    handler.handleEvent(std::move(startEvent));
    
    auto argsEvent = std::make_unique<ToolCallArgsEvent>();
    argsEvent->toolCallId = "call1";
    argsEvent->delta = "{\"query\":\"test\"}";
    handler.handleEvent(std::move(argsEvent));
    
    auto endEvent = std::make_unique<ToolCallEndEvent>();
    endEvent->toolCallId = "call1";
    handler.handleEvent(std::move(endEvent));
    
    // Test: Send ToolCallResultEvent
    auto resultEvent = std::make_unique<ToolCallResultEvent>();
    resultEvent->toolCallId = "call1";
    resultEvent->content = "{\"status\":\"success\",\"data\":\"found\"}";
    handler.handleEvent(std::move(resultEvent));
    
    // Verify: onToolCallResult callback was triggered
    EXPECT_EQ(subscriber->onToolCallResultCallCount, 1);
    EXPECT_EQ(subscriber->lastToolCallResult, "{\"status\":\"success\",\"data\":\"found\"}");
}

TEST(EventHandlerTest, ToolCallResultEventWithMultipleResults) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    
    EventHandler handler(messages, state, {subscriber});
    
    // Setup: Create two tool calls
    auto startEvent1 = std::make_unique<ToolCallStartEvent>();
    startEvent1->parentMessageId = "msg1";
    startEvent1->toolCallId = "call1";
    startEvent1->toolCallName = "tool1";
    handler.handleEvent(std::move(startEvent1));
    
    auto argsEvent1 = std::make_unique<ToolCallArgsEvent>();
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
    argsEvent2->toolCallId = "call2";
    argsEvent2->delta = "{\"param\":\"value2\"}";
    handler.handleEvent(std::move(argsEvent2));
    
    auto endEvent2 = std::make_unique<ToolCallEndEvent>();
    endEvent2->toolCallId = "call2";
    handler.handleEvent(std::move(endEvent2));
    
    // Test: Send ToolCallResultEvents for both tool calls
    auto resultEvent1 = std::make_unique<ToolCallResultEvent>();
    resultEvent1->toolCallId = "call1";
    resultEvent1->content = "result1";
    handler.handleEvent(std::move(resultEvent1));
    
    auto resultEvent2 = std::make_unique<ToolCallResultEvent>();
    resultEvent2->toolCallId = "call2";
    resultEvent2->content = "result2";
    handler.handleEvent(std::move(resultEvent2));
    
    // Verify: Both tool result messages were created
    EXPECT_EQ(handler.messages().size(), 3); // 1 assistant + 2 tool results
    EXPECT_EQ(subscriber->onToolCallResultCallCount, 2);
    EXPECT_EQ(handler.messages()[1].content(), "result1");
    EXPECT_EQ(handler.messages()[2].content(), "result2");
}

TEST(EventHandlerTest, ToolCallWithoutParentMessageIdUsesToolCallIdAsFallbackMessageId) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();

    EventHandler handler(messages, state, {subscriber});

    auto startEvent = std::make_unique<ToolCallStartEvent>();
    startEvent->toolCallId = "call-123";
    startEvent->toolCallName = "search";
    handler.handleEvent(std::move(startEvent));

    auto argsEvent = std::make_unique<ToolCallArgsEvent>();
    argsEvent->toolCallId = "call-123";
    argsEvent->delta = "{\"query\":\"test\"}";
    handler.handleEvent(std::move(argsEvent));

    ASSERT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].id(), "call-123");
    ASSERT_EQ(handler.messages()[0].toolCalls().size(), 1);
    EXPECT_EQ(handler.messages()[0].toolCalls()[0].function.arguments, "{\"query\":\"test\"}");
}

TEST(EventHandlerTest, TextMessageStartReusesPlaceholderCreatedByToolCallStart) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();

    EventHandler handler(messages, state);

    auto toolStart = std::make_unique<ToolCallStartEvent>();
    toolStart->toolCallId = "call-123";
    toolStart->toolCallName = "search";
    toolStart->parentMessageId = "msg-1";
    handler.handleEvent(std::move(toolStart));

    ASSERT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].id(), "msg-1");
    EXPECT_EQ(handler.messages()[0].toolCalls().size(), 1);

    auto textStart = std::make_unique<TextMessageStartEvent>();
    textStart->messageId = "msg-1";
    textStart->role = MessageRole::Assistant;
    handler.handleEvent(std::move(textStart));

    EXPECT_EQ(handler.messages().size(), 1);
    EXPECT_EQ(handler.messages()[0].id(), "msg-1");
}

// MessagesSnapshotEvent Tests
TEST(EventHandlerTest, MessagesSnapshotReplacesMessages) {
    std::vector<Message> messages;
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    
    // Add some initial messages
    messages.push_back(Message::createWithId("msg1", MessageRole::User, "Hello"));
    messages.push_back(Message::createWithId("msg2", MessageRole::Assistant, "Hi there"));
    
    EventHandler handler(messages, state, {subscriber});
    EXPECT_EQ(handler.messages().size(), 2);
    
    // Create new messages for snapshot
    std::vector<Message> newMessages;
    newMessages.push_back(Message::createWithId("new1", MessageRole::User, "New message"));
    newMessages.push_back(Message::createWithId("msg2", MessageRole::Assistant, "Second"));
    
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

// ============================================================
// ActivitySnapshotEvent tests
// ============================================================

// Test: ActivitySnapshotEvent creates a new Activity message when none exists
TEST(EventHandlerTest, ActivitySnapshotCreatesNewMessage) {
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    EventHandler handler({}, state, {subscriber});

    auto evt = std::make_unique<ActivitySnapshotEvent>();
    evt->messageId    = "act1";
    evt->activityType = "PLAN";
    evt->content      = nlohmann::json{{"step", 1}};
    evt->replace      = true;

    handler.handleEvent(std::move(evt));

    // Message should have been created
    ASSERT_EQ(handler.messages().size(), 1u);
    const Message& msg = handler.messages()[0];
    EXPECT_EQ(msg.id(),   "act1");
    EXPECT_EQ(msg.role(), MessageRole::Activity);
    EXPECT_EQ(msg.activityType(), "PLAN");
    // Content is stored as JSON dump
    nlohmann::json storedContent = nlohmann::json::parse(msg.content());
    EXPECT_EQ(storedContent["step"], 1);

    // Subscriber callbacks
    EXPECT_EQ(subscriber->onNewMessageCallCount,       1);
    EXPECT_EQ(subscriber->onMessagesChangedCallCount,  1);
    EXPECT_EQ(subscriber->onActivitySnapshotCallCount, 1);
}

// Test: ActivitySnapshotEvent with replace=true updates an existing Activity message
TEST(EventHandlerTest, ActivitySnapshotReplacesExistingMessage) {
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    EventHandler handler({}, state, {subscriber});

    // First snapshot — create the message
    {
        auto evt = std::make_unique<ActivitySnapshotEvent>();
        evt->messageId    = "act1";
        evt->activityType = "SEARCH";
        evt->content      = nlohmann::json{{"query", "hello"}};
        evt->replace      = true;
        handler.handleEvent(std::move(evt));
    }
    ASSERT_EQ(handler.messages().size(), 1u);

    // Second snapshot — replace content
    {
        auto evt = std::make_unique<ActivitySnapshotEvent>();
        evt->messageId    = "act1";
        evt->activityType = "SEARCH";
        evt->content      = nlohmann::json{{"query", "world"}};
        evt->replace      = true;
        handler.handleEvent(std::move(evt));
    }

    // Still only one message (no duplicate created)
    ASSERT_EQ(handler.messages().size(), 1u);
    const Message& msg = handler.messages()[0];
    nlohmann::json storedContent = nlohmann::json::parse(msg.content());
    EXPECT_EQ(storedContent["query"], "world");

    // onNewMessage only called once (first snapshot)
    EXPECT_EQ(subscriber->onNewMessageCallCount,       1);
    EXPECT_EQ(subscriber->onActivitySnapshotCallCount, 2);
    EXPECT_EQ(subscriber->onMessagesChangedCallCount,  2);
}

// Test: ActivitySnapshotEvent with replace=false does NOT overwrite existing content
TEST(EventHandlerTest, ActivitySnapshotNoReplaceWhenFlagFalse) {
    nlohmann::json state = nlohmann::json::object();
    EventHandler handler({}, state, {});

    // First snapshot — create the message
    {
        auto evt = std::make_unique<ActivitySnapshotEvent>();
        evt->messageId    = "act1";
        evt->activityType = "PLAN";
        evt->content      = nlohmann::json{{"original", true}};
        evt->replace      = true;
        handler.handleEvent(std::move(evt));
    }

    // Second snapshot with replace=false — should NOT change existing content
    {
        auto evt = std::make_unique<ActivitySnapshotEvent>();
        evt->messageId    = "act1";
        evt->activityType = "PLAN";
        evt->content      = nlohmann::json{{"replaced", true}};
        evt->replace      = false;
        handler.handleEvent(std::move(evt));
    }

    ASSERT_EQ(handler.messages().size(), 1u);
    nlohmann::json storedContent = nlohmann::json::parse(handler.messages()[0].content());
    // Content should remain unchanged
    EXPECT_TRUE(storedContent.contains("original"));
    EXPECT_FALSE(storedContent.contains("replaced"));
}

// Test: ActivityDeltaEvent applies a JSON Patch to an existing Activity message
TEST(EventHandlerTest, ActivityDeltaAppliesPatchToExistingMessage) {
    nlohmann::json state = nlohmann::json::object();
    auto subscriber = std::make_shared<MockSubscriber>();
    EventHandler handler({}, state, {subscriber});

    // Create the Activity message first
    {
        auto snapshot = std::make_unique<ActivitySnapshotEvent>();
        snapshot->messageId    = "act1";
        snapshot->activityType = "PLAN";
        snapshot->content      = nlohmann::json{{"step", 1}};
        snapshot->replace      = true;
        handler.handleEvent(std::move(snapshot));
    }
    subscriber->onMessagesChangedCallCount = 0;  // reset counter

    // Apply delta: replace /step value
    {
        auto delta = std::make_unique<ActivityDeltaEvent>();
        delta->messageId    = "act1";
        delta->activityType = "PLAN";
        JsonPatchOp op;
        op.op    = PatchOperation::Replace;
        op.path  = "/step";
        op.value = 2;
        delta->patch.push_back(op);
        handler.handleEvent(std::move(delta));
    }

    ASSERT_EQ(handler.messages().size(), 1u);
    nlohmann::json storedContent = nlohmann::json::parse(handler.messages()[0].content());
    EXPECT_EQ(storedContent["step"], 2);

    EXPECT_EQ(subscriber->onActivityDeltaCallCount,   1);
    EXPECT_EQ(subscriber->onMessagesChangedCallCount,  1);
}

// ── notifyRunFailed / notifyRunFinalized best-effort semantics ────────────────
// Verify that when one subscriber's onRunFailed (or onRunFinalized) throws,
// the remaining subscribers are still notified.  This is the "best-effort"
// contract: unlike notifySubscribers (which stops on the first failure),
// these terminal callbacks must complete the notification sweep regardless.

class ThrowingRunFailedSubscriber : public IAgentSubscriber {
public:
    bool didThrow = false;
    void onRunFailed(const AgentError&, const AgentSubscriberParams&) override {
        didThrow = true;
        throw std::runtime_error("subscriber failure in onRunFailed");
    }
};

class CountingRunFailedSubscriber : public IAgentSubscriber {
public:
    int runFailedCount = 0;
    int runFinalizedCount = 0;
    void onRunFailed(const AgentError&, const AgentSubscriberParams&) override {
        runFailedCount++;
    }
    void onRunFinalized(const AgentSubscriberParams&) override {
        runFinalizedCount++;
    }
};

TEST(EventHandlerTest, NotifyRunFailedContinuesAfterSubscriberThrows) {
    nlohmann::json state = nlohmann::json::object();
    auto thrower = std::make_shared<ThrowingRunFailedSubscriber>();
    auto counter = std::make_shared<CountingRunFailedSubscriber>();

    // thrower is first; counter must still receive the notification
    EventHandler handler({}, state, {thrower, counter});

    AgentError err(ErrorType::Execution, ErrorCode::ExecutionAgentFailed, "test error");
    handler.notifyRunFailed(err);

    EXPECT_TRUE(thrower->didThrow);
    EXPECT_EQ(counter->runFailedCount, 1);
}

TEST(EventHandlerTest, NotifyRunFinalizedContinuesAfterSubscriberThrows) {
    class ThrowingFinalizedSubscriber : public IAgentSubscriber {
    public:
        void onRunFinalized(const AgentSubscriberParams&) override {
            throw std::runtime_error("subscriber failure in onRunFinalized");
        }
    };

    nlohmann::json state = nlohmann::json::object();
    auto thrower = std::make_shared<ThrowingFinalizedSubscriber>();
    auto counter = std::make_shared<CountingRunFailedSubscriber>();

    EventHandler handler({}, state, {thrower, counter});
    handler.notifyRunFinalized();

    EXPECT_EQ(counter->runFinalizedCount, 1);
}

// Test: ActivityDeltaEvent on unknown messageId throws AgentError
TEST(EventHandlerTest, ActivityDeltaUnknownMessageIdThrows) {
    nlohmann::json state = nlohmann::json::object();
    EventHandler handler({}, state, {});

    auto delta = std::make_unique<ActivityDeltaEvent>();
    delta->messageId    = "nonexistent";
    delta->activityType = "PLAN";
    JsonPatchOp op;
    op.op    = PatchOperation::Add;
    op.path  = "/key";
    op.value = "value";
    delta->patch.push_back(op);

    EXPECT_THROW(handler.handleEvent(std::move(delta)), AgentError);
}
