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
    startEvent.role = "assistant";

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
    startEvent.role = "assistant";

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
    startEvent.role = "assistant";

    EXPECT_NO_THROW(verifier.verify(startEvent));
    
    // Second START for same message should throw
    EXPECT_THROW(verifier.verify(startEvent), AgentError);
}

TEST(EventVerifierTest, DuplicateEnd) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = "assistant";

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
    start1.role = "assistant";

    TextMessageStartEvent start2;
    start2.messageId = "msg-2";
    start2.role = "user";

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
    startEvent.role = "assistant";

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

// Reset Tests
TEST(EventVerifierTest, ResetVerifier) {
    EventVerifier verifier;
    
    TextMessageStartEvent startEvent;
    startEvent.messageId = "msg-1";
    startEvent.role = "assistant";

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
    msgStart.role = "assistant";
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
    startEvent.role = "assistant";

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
    start1.role = "assistant";
    verifier.verify(start1);
    
    TextMessageStartEvent start2;
    start2.messageId = "msg-2";
    start2.role = "user";
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
