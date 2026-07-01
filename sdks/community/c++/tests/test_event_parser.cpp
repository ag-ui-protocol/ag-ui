/**
 * @file test_event_parser.cpp
 * @brief EventParser round-trip tests for all 27 event types
 *
 * Each test verifies that toJson() → EventParser::parse() produces an event
 * of the correct type and that key fields survive the round-trip.
 */

#include <gtest/gtest.h>
#include <nlohmann/json.hpp>
#include <string>

#include "core/event.h"
#include "core/session_types.h"

using namespace agui;

// Helper: parse a JSON object through EventParser
static std::unique_ptr<Event> parseJson(const nlohmann::json& j) {
    return std::unique_ptr<Event>(EventParser::parse(j));
}

// ── Text Message Events ────────────────────────────────────────────────────

TEST(EventParserTest, TextMessageStart_RoundTrip) {
    TextMessageStartEvent src;
    src.messageId = "msg-1";
    src.role = MessageRole::Assistant;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::TextMessageStart);

    auto* evt = static_cast<TextMessageStartEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "msg-1");
    ASSERT_TRUE(evt->role.has_value());
    EXPECT_EQ(evt->role.value(), MessageRole::Assistant);
}

TEST(EventParserTest, TextMessageStart_NoRole) {
    TextMessageStartEvent src;
    src.messageId = "msg-2";
    // role not set

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    auto* evt = static_cast<TextMessageStartEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "msg-2");
    EXPECT_FALSE(evt->role.has_value());
}

TEST(EventParserTest, TextMessageContent_RoundTrip) {
    TextMessageContentEvent src;
    src.messageId = "msg-1";
    src.delta = "Hello, world!";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::TextMessageContent);

    auto* evt = static_cast<TextMessageContentEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "msg-1");
    EXPECT_EQ(evt->delta, "Hello, world!");
}

TEST(EventParserTest, TextMessageEnd_RoundTrip) {
    TextMessageEndEvent src;
    src.messageId = "msg-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::TextMessageEnd);

    auto* evt = static_cast<TextMessageEndEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "msg-1");
}

TEST(EventParserTest, TextMessageChunk_RoundTrip) {
    TextMessageChunkEvent src;
    src.messageId = "msg-1";
    src.delta = "chunk";
    src.role = MessageRole::User;
    src.name = "alice";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::TextMessageChunk);

    auto* evt = static_cast<TextMessageChunkEvent*>(parsed.get());
    EXPECT_EQ(evt->delta, "chunk");
    ASSERT_TRUE(evt->role.has_value());
    EXPECT_EQ(evt->role.value(), MessageRole::User);
    ASSERT_TRUE(evt->name.has_value());
    EXPECT_EQ(evt->name.value(), "alice");
}

// ── Thinking Message Events ────────────────────────────────────────────────

TEST(EventParserTest, ThinkingTextMessageStart_RoundTrip) {
    ThinkingTextMessageStartEvent src;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ThinkingTextMessageStart);
}

TEST(EventParserTest, ThinkingTextMessageContent_RoundTrip) {
    ThinkingTextMessageContentEvent src;
    src.delta = "thinking...";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ThinkingTextMessageContent);

    auto* evt = static_cast<ThinkingTextMessageContentEvent*>(parsed.get());
    EXPECT_EQ(evt->delta, "thinking...");
}

TEST(EventParserTest, ThinkingTextMessageEnd_RoundTrip) {
    ThinkingTextMessageEndEvent src;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ThinkingTextMessageEnd);
}

// ── Tool Call Events ───────────────────────────────────────────────────────

TEST(EventParserTest, ToolCallStart_RoundTrip) {
    ToolCallStartEvent src;
    src.toolCallId = "call-1";
    src.toolCallName = "search";
    src.parentMessageId = "msg-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ToolCallStart);

    auto* evt = static_cast<ToolCallStartEvent*>(parsed.get());
    EXPECT_EQ(evt->toolCallId, "call-1");
    EXPECT_EQ(evt->toolCallName, "search");
    ASSERT_TRUE(evt->parentMessageId.has_value());
    EXPECT_EQ(evt->parentMessageId.value(), "msg-1");
}

TEST(EventParserTest, ToolCallArgs_RoundTrip) {
    ToolCallArgsEvent src;
    src.toolCallId = "call-1";
    src.delta = "{\"q\":";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ToolCallArgs);

    auto* evt = static_cast<ToolCallArgsEvent*>(parsed.get());
    EXPECT_EQ(evt->toolCallId, "call-1");
    EXPECT_EQ(evt->delta, "{\"q\":");
}

TEST(EventParserTest, ToolCallEnd_RoundTrip) {
    ToolCallEndEvent src;
    src.toolCallId = "call-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ToolCallEnd);

    auto* evt = static_cast<ToolCallEndEvent*>(parsed.get());
    EXPECT_EQ(evt->toolCallId, "call-1");
}

TEST(EventParserTest, ToolCallChunk_RoundTrip) {
    ToolCallChunkEvent src;
    src.toolCallId = "call-1";
    src.toolCallName = "search";
    src.delta = "arg_chunk";
    src.parentMessageId = "msg-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ToolCallChunk);

    auto* evt = static_cast<ToolCallChunkEvent*>(parsed.get());
    EXPECT_EQ(evt->toolCallId, "call-1");
    ASSERT_TRUE(evt->toolCallName.has_value());
    EXPECT_EQ(evt->toolCallName.value(), "search");
    EXPECT_EQ(evt->delta, "arg_chunk");
}

TEST(EventParserTest, ToolCallResult_RoundTrip) {
    ToolCallResultEvent src;
    src.messageId = "msg-1";
    src.toolCallId = "call-1";
    src.content = "search result";
    src.role = MessageRole::Tool;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ToolCallResult);

    auto* evt = static_cast<ToolCallResultEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "msg-1");
    EXPECT_EQ(evt->content, "search result");
    ASSERT_TRUE(evt->role.has_value());
    EXPECT_EQ(evt->role.value(), MessageRole::Tool);
}

// ── Thinking Step Events ───────────────────────────────────────────────────

TEST(EventParserTest, ThinkingStart_RoundTrip) {
    ThinkingStartEvent src;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ThinkingStart);
}

TEST(EventParserTest, ThinkingEnd_RoundTrip) {
    ThinkingEndEvent src;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ThinkingEnd);
}

// ── State Management Events ────────────────────────────────────────────────

TEST(EventParserTest, StateSnapshot_RoundTrip) {
    StateSnapshotEvent src;
    src.snapshot = {{"count", 42}, {"name", "test"}};

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::StateSnapshot);

    auto* evt = static_cast<StateSnapshotEvent*>(parsed.get());
    EXPECT_EQ(evt->snapshot["count"], 42);
    EXPECT_EQ(evt->snapshot["name"], "test");
}

TEST(EventParserTest, StateDelta_RoundTrip) {
    StateDeltaEvent src;
    src.delta = nlohmann::json::array({{{"op", "replace"}, {"path", "/count"}, {"value", 99}}});

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::StateDelta);

    auto* evt = static_cast<StateDeltaEvent*>(parsed.get());
    ASSERT_TRUE(evt->delta.is_array());
    EXPECT_EQ(evt->delta[0]["op"], "replace");
    EXPECT_EQ(evt->delta[0]["value"], 99);
}

TEST(EventParserTest, MessagesSnapshot_RoundTrip) {
    MessagesSnapshotEvent src;
    src.messages.push_back(Message::createWithId("m1", MessageRole::User, "hello"));

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::MessagesSnapshot);

    auto* evt = static_cast<MessagesSnapshotEvent*>(parsed.get());
    ASSERT_EQ(evt->messages.size(), 1u);
    EXPECT_EQ(evt->messages[0].id(), "m1");
}

// ── Run Lifecycle Events ───────────────────────────────────────────────────

TEST(EventParserTest, RunStarted_RoundTrip) {
    RunStartedEvent src;
    src.threadId = "thread-1";
    src.runId = "run-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::RunStarted);

    auto* evt = static_cast<RunStartedEvent*>(parsed.get());
    EXPECT_EQ(evt->threadId, "thread-1");
    EXPECT_EQ(evt->runId, "run-1");
}

TEST(EventParserTest, RunFinished_RoundTrip) {
    RunFinishedEvent src;
    src.threadId = "thread-1";
    src.runId = "run-1";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::RunFinished);

    auto* evt = static_cast<RunFinishedEvent*>(parsed.get());
    EXPECT_EQ(evt->threadId, "thread-1");
    EXPECT_EQ(evt->runId, "run-1");
}

TEST(EventParserTest, RunError_RoundTrip) {
    RunErrorEvent src;
    src.message = "agent failed";
    src.code = std::string("ERR_001");

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::RunError);

    auto* evt = static_cast<RunErrorEvent*>(parsed.get());
    EXPECT_EQ(evt->message, "agent failed");
    ASSERT_TRUE(evt->code.has_value());
    EXPECT_EQ(evt->code.value(), "ERR_001");
}

// ── Step Events ────────────────────────────────────────────────────────────

TEST(EventParserTest, StepStarted_RoundTrip) {
    StepStartedEvent src;
    src.stepName = "planning";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::StepStarted);

    auto* evt = static_cast<StepStartedEvent*>(parsed.get());
    EXPECT_EQ(evt->stepName, "planning");
}

TEST(EventParserTest, StepFinished_RoundTrip) {
    StepFinishedEvent src;
    src.stepName = "planning";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::StepFinished);

    auto* evt = static_cast<StepFinishedEvent*>(parsed.get());
    EXPECT_EQ(evt->stepName, "planning");
}

// ── Unknown/Missing Type Handling ─────────────────────────────────────────

// EventParser::parse() throws AgentError on unknown event types.
TEST(EventParserTest, UnknownType_ThrowsAgentError) {
    nlohmann::json j = {{"type", "NONEXISTENT_TYPE_XYZ"}};
    EXPECT_THROW(parseJson(j), AgentError);
}

// EventParser::parse() throws AgentError when the 'type' field is absent.
TEST(EventParserTest, MissingTypeField_ThrowsAgentError) {
    nlohmann::json j = {{"messageId", "msg-1"}};
    EXPECT_THROW(parseJson(j), AgentError);
}

// ── T-4: Activity Events Round-Trip ───────────────────────────────────────────

TEST(EventParserTest, ActivitySnapshot_RoundTrip) {
    ActivitySnapshotEvent src;
    src.messageId = "act-1";
    src.activityType = "PLAN";
    src.content = {{"step", 1}, {"status", "running"}};
    src.replace = false;

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ActivitySnapshot);

    auto* evt = static_cast<ActivitySnapshotEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "act-1");
    EXPECT_EQ(evt->activityType, "PLAN");
    EXPECT_EQ(evt->content["step"], 1);
    EXPECT_EQ(evt->content["status"], "running");
    EXPECT_FALSE(evt->replace);
}

TEST(EventParserTest, ActivityDelta_RoundTrip) {
    ActivityDeltaEvent src;
    src.messageId = "act-2";
    src.activityType = "SEARCH";
    JsonPatchOp op;
    op.op = PatchOperation::Replace;
    op.path = "/step";
    op.value = 2;
    op.hasValue = true;
    src.patch.push_back(op);

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::ActivityDelta);

    auto* evt = static_cast<ActivityDeltaEvent*>(parsed.get());
    EXPECT_EQ(evt->messageId, "act-2");
    EXPECT_EQ(evt->activityType, "SEARCH");
    ASSERT_EQ(evt->patch.size(), 1u);
    EXPECT_EQ(evt->patch[0].op, PatchOperation::Replace);
    EXPECT_EQ(evt->patch[0].path, "/step");
    EXPECT_EQ(evt->patch[0].value, 2);
}

// ── T-5: RawEvent / CustomEvent Round-Trip ────────────────────────────────────

TEST(EventParserTest, RawEvent_RoundTrip) {
    RawEvent src;
    src.event = {{"key", "value"}, {"count", 42}};
    src.source = "external-system";

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::Raw);

    auto* evt = static_cast<RawEvent*>(parsed.get());
    EXPECT_EQ(evt->event["key"], "value");
    EXPECT_EQ(evt->event["count"], 42);
    ASSERT_TRUE(evt->source.has_value());
    EXPECT_EQ(evt->source.value(), "external-system");
}

TEST(EventParserTest, RawEvent_NoSource_RoundTrip) {
    RawEvent src;
    src.event = {{"data", "test"}};
    // source not set

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::Raw);

    auto* evt = static_cast<RawEvent*>(parsed.get());
    EXPECT_EQ(evt->event["data"], "test");
    EXPECT_FALSE(evt->source.has_value());
}

TEST(EventParserTest, CustomEvent_RoundTrip) {
    CustomEvent src;
    src.name = "user-action";
    src.value = {{"action", "click"}, {"target", "button"}};

    auto parsed = parseJson(src.toJson());
    ASSERT_NE(parsed, nullptr);
    EXPECT_EQ(parsed->type(), EventType::Custom);

    auto* evt = static_cast<CustomEvent*>(parsed.get());
    EXPECT_EQ(evt->name, "user-action");
    EXPECT_EQ(evt->value["action"], "click");
    EXPECT_EQ(evt->value["target"], "button");
}

// ── T-6: Event::validate() direct tests ──────────────────────────────────────

TEST(EventValidateTest, TextMessageStart_EmptyMessageIdThrows) {
    TextMessageStartEvent evt;
    evt.messageId = "";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, TextMessageStart_ValidDoesNotThrow) {
    TextMessageStartEvent evt;
    evt.messageId = "msg-1";
    EXPECT_NO_THROW(evt.validate());
}

TEST(EventValidateTest, TextMessageStart_ToolRoleThrows) {
    TextMessageStartEvent evt;
    evt.messageId = "msg-1";
    evt.role = MessageRole::Tool;
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, TextMessageContent_EmptyDeltaThrows) {
    TextMessageContentEvent evt;
    evt.messageId = "msg-1";
    evt.delta = "";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, ToolCallStart_EmptyToolCallIdThrows) {
    ToolCallStartEvent evt;
    evt.toolCallId = "";
    evt.toolCallName = "search";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, ToolCallResult_NonToolRoleThrows) {
    ToolCallResultEvent evt;
    evt.toolCallId = "call-1";
    evt.role = MessageRole::User;
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, ActivitySnapshot_EmptyMessageIdThrows) {
    ActivitySnapshotEvent evt;
    evt.messageId = "";
    evt.activityType = "PLAN";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, ActivitySnapshot_EmptyActivityTypeThrows) {
    ActivitySnapshotEvent evt;
    evt.messageId = "act-1";
    evt.activityType = "";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, ActivityDelta_EmptyMessageIdThrows) {
    ActivityDeltaEvent evt;
    evt.messageId = "";
    evt.activityType = "SEARCH";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, RunStarted_EmptyThreadIdThrows) {
    RunStartedEvent evt;
    evt.threadId = "";
    evt.runId = "run-1";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, RunError_EmptyMessageThrows) {
    RunErrorEvent evt;
    evt.message = "";
    EXPECT_THROW(evt.validate(), AgentError);
}

TEST(EventValidateTest, StepStarted_EmptyStepNameThrows) {
    StepStartedEvent evt;
    evt.stepName = "";
    EXPECT_THROW(evt.validate(), AgentError);
}
