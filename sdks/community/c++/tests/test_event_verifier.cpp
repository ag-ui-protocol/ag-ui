/**
 * @file test_event_verifier.cpp
 * @brief Event Verifier functionality tests
 * 
 * Tests event lifecycle verification, state tracking, and validation
 */

#include <gtest/gtest.h>
#include <memory>
#include <string>

#include "core/event.h"
#include "core/event_verifier.h"

using namespace agui;

// Basic Message Lifecycle Tests
TEST(EventVerifierTest, ValidMessageLifecycle) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    TextMessageContentEvent contentEvent;
    contentEvent.messageId = "msg-1";
    contentEvent.delta = "Hello";

    TextMessageEndEvent endEvent;
    endEvent.messageId = "msg-1";

    // Valid sequence: START -> CONTENT -> END
    EXPECT_NO_THROW(verifier.verify(startEvent));
    EXPECT_NO_THROW(verifier.verify(contentEvent));
    EXPECT_NO_THROW(verifier.verify(endEvent));

    ASSERT_TRUE(verifier.isComplete());
}

TEST(EventVerifierTest, IncompleteMessage) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    EXPECT_NO_THROW(verifier.verify(startEvent));
    ASSERT_FALSE(verifier.isComplete());

    auto incomplete = verifier.getIncompleteMessages();
    EXPECT_EQ(incomplete.size(), 1);
    ASSERT_TRUE(incomplete.find("msg-1") != incomplete.end());
}

TEST(EventVerifierTest, ContentBeforeStart) {
    EventVerifier verifier;
    
    TextMessageContentEvent contentEvent;
    contentEvent.messageId = "msg-1";
    contentEvent.delta = "Hello";

    // This should throw because message was never started
    EXPECT_THROW(verifier.verify(contentEvent), AgentError);
}

TEST(EventVerifierTest, EndBeforeStart) {
    EventVerifier verifier;
    
    TextMessageEndEvent endEvent;
    endEvent.messageId = "msg-1";

    // This should throw because message was never started
    EXPECT_THROW(verifier.verify(endEvent), AgentError);
}

TEST(EventVerifierTest, DuplicateStart) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    EXPECT_NO_THROW(verifier.verify(startEvent));
    
    // Second START for same message should throw
    EXPECT_THROW(verifier.verify(startEvent), AgentError);
}

TEST(EventVerifierTest, DuplicateEnd) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    TextMessageEndEvent endEvent;
    endEvent.messageId = "msg-1";

    EXPECT_NO_THROW(verifier.verify(startEvent));
    EXPECT_NO_THROW(verifier.verify(endEvent));
    
    // Second END for same message should throw
    EXPECT_THROW(verifier.verify(endEvent), AgentError);
}

// Concurrent Messages Tests
TEST(EventVerifierTest, ConcurrentMessages) {
    EventVerifier verifier;
    
    TextMessageStartEvent start1;
    start1.messageId = "msg-1";
    start1.role = MessageRole::Assistant;

    TextMessageStartEvent start2;
    start2.messageId = "msg-2";
    start2.role = MessageRole::User;

    TextMessageEndEvent end1;
    end1.messageId = "msg-1";

    TextMessageEndEvent end2;
    end2.messageId = "msg-2";

    // Start both messages
    EXPECT_NO_THROW(verifier.verify(start1));
    EXPECT_NO_THROW(verifier.verify(start2));

    // End them in different order
    EXPECT_NO_THROW(verifier.verify(end2));
    EXPECT_NO_THROW(verifier.verify(end1));

    ASSERT_TRUE(verifier.isComplete());
}

// Tool Call Lifecycle Tests
TEST(EventVerifierTest, ValidToolCallLifecycle) {
    EventVerifier verifier;
    
    ToolCallStartEvent startEvent;
    startEvent.toolCallId = "tool-1";
    startEvent.toolCallName = "search";
    startEvent.parentMessageId = "msg-1";

    ToolCallArgsEvent argsEvent;
    argsEvent.toolCallId = "tool-1";
    argsEvent.delta = "{\"query\":";

    ToolCallEndEvent endEvent;
    endEvent.toolCallId = "tool-1";

    // Valid sequence: START -> ARGS -> END
    EXPECT_NO_THROW(verifier.verify(startEvent));
    EXPECT_NO_THROW(verifier.verify(argsEvent));
    EXPECT_NO_THROW(verifier.verify(endEvent));

    ASSERT_TRUE(verifier.isComplete());
}

TEST(EventVerifierTest, ToolCallArgsBeforeStart) {
    EventVerifier verifier;
    
    ToolCallArgsEvent argsEvent;
    argsEvent.toolCallId = "tool-1";
    argsEvent.delta = "{}";

    EXPECT_THROW(verifier.verify(argsEvent), AgentError);
}

TEST(EventVerifierTest, ConcurrentToolCalls) {
    EventVerifier verifier;
    
    ToolCallStartEvent start1;
    start1.toolCallId = "tool-1";
    start1.toolCallName = "search";

    ToolCallStartEvent start2;
    start2.toolCallId = "tool-2";
    start2.toolCallName = "calculate";

    ToolCallEndEvent end1;
    end1.toolCallId = "tool-1";

    ToolCallEndEvent end2;
    end2.toolCallId = "tool-2";

    EXPECT_NO_THROW(verifier.verify(start1));
    EXPECT_NO_THROW(verifier.verify(start2));
    EXPECT_NO_THROW(verifier.verify(end1));
    EXPECT_NO_THROW(verifier.verify(end2));

    ASSERT_TRUE(verifier.isComplete());
}

// Thinking Lifecycle Tests
TEST(EventVerifierTest, ValidThinkingLifecycle) {
    EventVerifier verifier;
    
    ThinkingStartEvent startEvent;
    ThinkingEndEvent endEvent;

    EXPECT_NO_THROW(verifier.verify(startEvent));
    ASSERT_TRUE(verifier.isThinkingActive());
    EXPECT_NO_THROW(verifier.verify(endEvent));
    ASSERT_FALSE(verifier.isThinkingActive());
}

TEST(EventVerifierTest, ThinkingEndBeforeStart) {
    EventVerifier verifier;
    
    ThinkingEndEvent endEvent;
    EXPECT_THROW(verifier.verify(endEvent), AgentError);
}

TEST(EventVerifierTest, DuplicateThinkingStart) {
    EventVerifier verifier;
    
    ThinkingStartEvent startEvent;
    
    EXPECT_NO_THROW(verifier.verify(startEvent));
    EXPECT_THROW(verifier.verify(startEvent), AgentError);
}

TEST(EventVerifierTest, ValidThinkingTextMessageLifecycle) {
    EventVerifier verifier;
    
    ThinkingTextMessageStartEvent startEvent;
    ThinkingTextMessageContentEvent contentEvent;
    contentEvent.delta = "Thinking...";
    ThinkingTextMessageEndEvent endEvent;

    EXPECT_NO_THROW(verifier.verify(startEvent));
    EXPECT_NO_THROW(verifier.verify(contentEvent));
    EXPECT_NO_THROW(verifier.verify(endEvent));

    ASSERT_TRUE(verifier.isComplete());
}

TEST(EventVerifierTest, ThinkingContentBeforeStart) {
    EventVerifier verifier;
    
    ThinkingTextMessageContentEvent contentEvent;
    contentEvent.delta = "Thinking...";

    EXPECT_THROW(verifier.verify(contentEvent), AgentError);
}

// State Query Tests
TEST(EventVerifierTest, GetMessageState) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    EXPECT_EQ(verifier.getMessageState("msg-1"), EventVerifier::EventState::NotStarted);
    
    verifier.verify(startEvent);
    EXPECT_EQ(verifier.getMessageState("msg-1"), EventVerifier::EventState::Started);
    
    TextMessageContentEvent contentEvent;
    contentEvent.messageId = "msg-1";
    contentEvent.delta = "Hello";
    verifier.verify(contentEvent);
    EXPECT_EQ(verifier.getMessageState("msg-1"), EventVerifier::EventState::InProgress);
    
    TextMessageEndEvent endEvent;
    endEvent.messageId = "msg-1";
    verifier.verify(endEvent);
    EXPECT_EQ(verifier.getMessageState("msg-1"), EventVerifier::EventState::Ended);
}

TEST(EventVerifierTest, GetToolCallState) {
    EventVerifier verifier;
    
    ToolCallStartEvent startEvent;
    startEvent.toolCallId = "tool-1";
    startEvent.toolCallName = "search";

    EXPECT_EQ(verifier.getToolCallState("tool-1"), EventVerifier::EventState::NotStarted);
    
    verifier.verify(startEvent);
    EXPECT_EQ(verifier.getToolCallState("tool-1"), EventVerifier::EventState::Started);
    
    ToolCallEndEvent endEvent;
    endEvent.toolCallId = "tool-1";
    verifier.verify(endEvent);
    EXPECT_EQ(verifier.getToolCallState("tool-1"), EventVerifier::EventState::Ended);
}

TEST(EventVerifierTest, ToolCallStartEventRoundTripsWithParentMessageId) {
    ToolCallStartEvent event;
    event.toolCallId = "call-1";
    event.toolCallName = "search";
    event.parentMessageId = "msg-1";

    const auto json = event.toJson();
    const auto parsed = ToolCallStartEvent::fromJson(json);

    EXPECT_EQ(parsed.toolCallId, "call-1");
    EXPECT_EQ(parsed.toolCallName, "search");
    ASSERT_TRUE(parsed.parentMessageId.has_value());
    EXPECT_EQ(parsed.parentMessageId.value(), "msg-1");
}

TEST(EventVerifierTest, ToolCallStartEventRoundTripsWithoutParentMessageId) {
    ToolCallStartEvent event;
    event.toolCallId = "call-1";
    event.toolCallName = "search";
    // parentMessageId intentionally not set

    const auto json = event.toJson();
    const auto parsed = ToolCallStartEvent::fromJson(json);

    EXPECT_EQ(parsed.toolCallId, "call-1");
    EXPECT_EQ(parsed.toolCallName, "search");
    EXPECT_FALSE(parsed.parentMessageId.has_value());
    EXPECT_FALSE(json.contains("parentMessageId"));
}

TEST(EventVerifierTest, ToolCallArgsEventRoundTripsWithoutMessageId) {
    ToolCallArgsEvent event;
    event.toolCallId = "call-1";
    event.delta = "{\"query\":\"test\"}";

    const auto json = event.toJson();
    const auto parsed = ToolCallArgsEvent::fromJson(json);

    EXPECT_EQ(parsed.toolCallId, "call-1");
    EXPECT_EQ(parsed.delta, "{\"query\":\"test\"}");
    // Verify the removed field is absent from the serialized JSON
    EXPECT_FALSE(json.contains("messageId"));
}

TEST(EventVerifierTest, RunStartedEventRoundTripsThreadId) {
    RunStartedEvent event;
    event.threadId = "thread-1";
    event.runId = "run-1";

    const auto json = event.toJson();
    const auto parsed = RunStartedEvent::fromJson(json);

    EXPECT_EQ(parsed.threadId, "thread-1");
    EXPECT_EQ(parsed.runId, "run-1");
}

TEST(EventVerifierTest, RunFinishedEventRoundTripsThreadId) {
    RunFinishedEvent event;
    event.threadId = "thread-1";
    event.runId = "run-1";
    event.result = {{"status", "ok"}};

    const auto json = event.toJson();
    const auto parsed = RunFinishedEvent::fromJson(json);

    EXPECT_EQ(parsed.threadId, "thread-1");
    EXPECT_EQ(parsed.runId, "run-1");
    EXPECT_EQ(parsed.result["status"], "ok");
}

// Reset Tests
TEST(EventVerifierTest, ResetVerifier) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = MessageRole::Assistant;

    EXPECT_NO_THROW(verifier.verify(startEvent));
    ASSERT_FALSE(verifier.isComplete());

    verifier.reset();
    ASSERT_TRUE(verifier.isComplete());
    
    // After reset, should be able to start new messages
    EXPECT_NO_THROW(verifier.verify(startEvent));
}

// Complex Scenario Tests
TEST(EventVerifierTest, ComplexScenario) {
    EventVerifier verifier;
    
    // Start message
    TextMessageStartEvent msgStart;
    msgStart.messageId = "msg-1";
    msgStart.role = MessageRole::Assistant;
    EXPECT_NO_THROW(verifier.verify(msgStart));

    // Start thinking
    ThinkingStartEvent thinkStart;
    EXPECT_NO_THROW(verifier.verify(thinkStart));

    // Start tool call
    ToolCallStartEvent toolStart;
    toolStart.toolCallId = "tool-1";
    toolStart.toolCallName = "search";
    EXPECT_NO_THROW(verifier.verify(toolStart));

    // Tool call args
    ToolCallArgsEvent toolArgs;
    toolArgs.toolCallId = "tool-1";
    toolArgs.delta = "{}";
    EXPECT_NO_THROW(verifier.verify(toolArgs));

    // End tool call
    ToolCallEndEvent toolEnd;
    toolEnd.toolCallId = "tool-1";
    EXPECT_NO_THROW(verifier.verify(toolEnd));

    // End thinking
    ThinkingEndEvent thinkEnd;
    EXPECT_NO_THROW(verifier.verify(thinkEnd));

    // Message content
    TextMessageContentEvent msgContent;
    msgContent.messageId = "msg-1";
    msgContent.delta = "Result";
    EXPECT_NO_THROW(verifier.verify(msgContent));

    // End message
    TextMessageEndEvent msgEnd;
    msgEnd.messageId = "msg-1";
    EXPECT_NO_THROW(verifier.verify(msgEnd));

    ASSERT_TRUE(verifier.isComplete());
}

// Validation Tests
TEST(EventVerifierTest, EmptyMessageId) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "";
    startEvent.role = MessageRole::Assistant;

    EXPECT_THROW(verifier.verify(startEvent), AgentError);
}

TEST(EventVerifierTest, EmptyToolCallId) {
    EventVerifier verifier;
    
    ToolCallStartEvent startEvent;
    startEvent.toolCallId = "";
    startEvent.toolCallName = "search";

    EXPECT_THROW(verifier.verify(startEvent), AgentError);
}

TEST(EventVerifierTest, MultipleIncompleteEvents) {
    EventVerifier verifier;
    
    // Start multiple messages without ending them
    TextMessageStartEvent start1;
    start1.messageId = "msg-1";
    start1.role = MessageRole::Assistant;
    verifier.verify(start1);
    
    TextMessageStartEvent start2;
    start2.messageId = "msg-2";
    start2.role = MessageRole::User;
    verifier.verify(start2);
    
    ToolCallStartEvent toolStart;
    toolStart.toolCallId = "tool-1";
    toolStart.toolCallName = "search";
    verifier.verify(toolStart);
    
    ASSERT_FALSE(verifier.isComplete());
    
    auto incompleteMessages = verifier.getIncompleteMessages();
    auto incompleteToolCalls = verifier.getIncompleteToolCalls();
    
    EXPECT_EQ(incompleteMessages.size(), 2);
    EXPECT_EQ(incompleteToolCalls.size(), 1);
}

TEST(EventVerifierTest, TextMessageChunkEventRoundTrips) {
    TextMessageChunkEvent event;
    event.messageId = "msg-1";
    event.delta = "Hello, world!";
    event.role = MessageRole::Assistant;
    event.name = "assistant-name";

    const auto json = event.toJson();
    const auto parsed = TextMessageChunkEvent::fromJson(json);

    EXPECT_EQ(parsed.messageId, "msg-1");
    EXPECT_EQ(parsed.delta, "Hello, world!");
    ASSERT_TRUE(parsed.role.has_value());
    EXPECT_EQ(parsed.role.value(), MessageRole::Assistant);
    ASSERT_TRUE(parsed.name.has_value());
    EXPECT_EQ(parsed.name.value(), "assistant-name");
    // Ensure the old field name is absent from serialized JSON
    EXPECT_FALSE(json.contains("content"));
    EXPECT_TRUE(json.contains("delta"));
}

TEST(EventVerifierTest, TextMessageChunkEventRoundTripsWithoutOptionalFields) {
    TextMessageChunkEvent event;
    event.messageId = "msg-1";
    event.delta = "chunk";

    const auto json = event.toJson();
    const auto parsed = TextMessageChunkEvent::fromJson(json);

    EXPECT_EQ(parsed.messageId, "msg-1");
    EXPECT_EQ(parsed.delta, "chunk");
    EXPECT_FALSE(parsed.role.has_value());
    EXPECT_FALSE(parsed.name.has_value());
    EXPECT_FALSE(json.contains("role"));
    EXPECT_FALSE(json.contains("name"));
}

TEST(EventVerifierTest, ToolCallChunkEventRoundTrips) {
    ToolCallChunkEvent event;
    event.toolCallId = "call-1";
    event.toolCallName = "search";
    event.delta = "{\"query\":";
    event.parentMessageId = "msg-1";

    const auto json = event.toJson();
    const auto parsed = ToolCallChunkEvent::fromJson(json);

    EXPECT_EQ(parsed.toolCallId, "call-1");
    ASSERT_TRUE(parsed.toolCallName.has_value());
    EXPECT_EQ(parsed.toolCallName.value(), "search");
    EXPECT_EQ(parsed.delta, "{\"query\":");
    ASSERT_TRUE(parsed.parentMessageId.has_value());
    EXPECT_EQ(parsed.parentMessageId.value(), "msg-1");
    EXPECT_FALSE(json.contains("arguments"));
    EXPECT_TRUE(json.contains("delta"));
}

TEST(EventVerifierTest, ToolCallChunkEventRoundTripsWithoutOptionalFields) {
    ToolCallChunkEvent event;
    event.toolCallId = "call-1";
    event.delta = "test";

    const auto json = event.toJson();
    const auto parsed = ToolCallChunkEvent::fromJson(json);

    EXPECT_EQ(parsed.toolCallId, "call-1");
    EXPECT_EQ(parsed.delta, "test");
    EXPECT_FALSE(parsed.toolCallName.has_value());
    EXPECT_FALSE(parsed.parentMessageId.has_value());
    EXPECT_FALSE(json.contains("toolCallName"));
    EXPECT_FALSE(json.contains("parentMessageId"));
}
