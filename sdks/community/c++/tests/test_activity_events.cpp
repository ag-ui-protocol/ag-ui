/**
 * @file test_activity_events.cpp
 * @brief Activity Events functionality tests
 *
 * Tests ActivitySnapshotEvent, ActivityDeltaEvent, JsonPatchOp and EventParser
 */

#include <gtest/gtest.h>
#include <memory>
#include <string>

#include "core/event.h"
#include "core/state.h"

using namespace agui;

// ActivitySnapshotEvent Tests
TEST(ActivityEventsTest, ActivitySnapshotEventBasic) {
    ActivitySnapshotEvent event;
    event.messageId = "msg-123";
    event.activityType = "PLAN";
    event.content = nlohmann::json{{"step", 1}, {"description", "Planning phase"}};
    event.replace = true;

    // Test toJson
    nlohmann::json j = event.toJson();
    EXPECT_EQ(j["type"], "ACTIVITY_SNAPSHOT");
    EXPECT_EQ(j["messageId"], "msg-123");
    EXPECT_EQ(j["activityType"], "PLAN");
    EXPECT_EQ(j["content"]["step"], 1);
    EXPECT_EQ(j["content"]["description"], "Planning phase");
    EXPECT_EQ(j["replace"], true);
}

TEST(ActivityEventsTest, ActivitySnapshotEventFromJson) {
    nlohmann::json j = {
        {"type", "ACTIVITY_SNAPSHOT"},
        {"messageId", "msg-456"},
        {"activityType", "SEARCH"},
        {"content", {{"query", "test"}, {"results", 5}}},
        {"replace", false}
    };

    ActivitySnapshotEvent event = ActivitySnapshotEvent::fromJson(j);
    EXPECT_EQ(event.messageId, "msg-456");
    EXPECT_EQ(event.activityType, "SEARCH");
    EXPECT_EQ(event.content["query"], "test");
    EXPECT_EQ(event.content["results"], 5);
    EXPECT_EQ(event.replace, false);
}

TEST(ActivityEventsTest, ActivitySnapshotEventValidation) {
    ActivitySnapshotEvent event;
    
    // Missing messageId
    event.activityType = "PLAN";
    event.content = nlohmann::json{{"test", "data"}};
    EXPECT_THROW(event.validate(), AgentError);
    
    // Missing activityType
    event.messageId = "msg-123";
    event.activityType = "";
    EXPECT_THROW(event.validate(), AgentError);
    
    // Missing content
    event.activityType = "PLAN";
    event.content = nlohmann::json();
    EXPECT_THROW(event.validate(), AgentError);
    
    // Valid event
    event.content = nlohmann::json{{"test", "data"}};
    EXPECT_NO_THROW(event.validate());
}

// JsonPatchOp Tests
TEST(ActivityEventsTest, JsonPatchOpBasic) {
    JsonPatchOp op;
    op.op = PatchOperation::Add;
    op.path = "/status";
    op.value = "completed";

    nlohmann::json j = op.toJson();
    EXPECT_EQ(j["op"], "add");
    EXPECT_EQ(j["path"], "/status");
    EXPECT_EQ(j["value"], "completed");
}

TEST(ActivityEventsTest, JsonPatchOpValidation) {
    JsonPatchOp op;

    // Invalid path (doesn't start with /)
    op.op = PatchOperation::Add;
    op.path = "test";
    EXPECT_THROW(op.validate(), AgentError);

    // move operation without from
    op.op = PatchOperation::Move;
    op.path = "/new";
    EXPECT_THROW(op.validate(), AgentError);

    // add operation without value (null counts as missing)
    op.op = PatchOperation::Add;
    op.path = "/test";
    op.value = nlohmann::json();
    EXPECT_THROW(op.validate(), AgentError);

    // Valid add operation
    op.value = "test";
    EXPECT_NO_THROW(op.validate());

    // Valid move operation
    op.op = PatchOperation::Move;
    op.from = "/old";
    op.value = nlohmann::json();
    EXPECT_NO_THROW(op.validate());
}

TEST(ActivityEventsTest, JsonPatchOpAllTypes) {
    // add
    JsonPatchOp addOp;
    addOp.op = PatchOperation::Add;
    addOp.path = "/test";
    addOp.value = "value";
    EXPECT_NO_THROW(addOp.validate());

    // remove (no value required)
    JsonPatchOp removeOp;
    removeOp.op = PatchOperation::Remove;
    removeOp.path = "/test";
    EXPECT_NO_THROW(removeOp.validate());

    // replace
    JsonPatchOp replaceOp;
    replaceOp.op = PatchOperation::Replace;
    replaceOp.path = "/test";
    replaceOp.value = "value";
    EXPECT_NO_THROW(replaceOp.validate());

    // move
    JsonPatchOp moveOp;
    moveOp.op = PatchOperation::Move;
    moveOp.path = "/test";
    moveOp.from = "/source";
    EXPECT_NO_THROW(moveOp.validate());

    // copy
    JsonPatchOp copyOp;
    copyOp.op = PatchOperation::Copy;
    copyOp.path = "/test";
    copyOp.from = "/source";
    EXPECT_NO_THROW(copyOp.validate());

    // test
    JsonPatchOp testOp;
    testOp.op = PatchOperation::Test;
    testOp.path = "/test";
    testOp.value = "value";
    EXPECT_NO_THROW(testOp.validate());
}

// ActivityDeltaEvent Tests
TEST(ActivityEventsTest, ActivityDeltaEventBasic) {
    ActivityDeltaEvent event;
    event.messageId = "msg-789";
    event.activityType = "PLAN";

    JsonPatchOp op1;
    op1.op = PatchOperation::Add;
    op1.path = "/step";
    op1.value = 2;

    JsonPatchOp op2;
    op2.op = PatchOperation::Replace;
    op2.path = "/status";
    op2.value = "in_progress";

    event.patch.push_back(op1);
    event.patch.push_back(op2);

    // Test toJson
    nlohmann::json j = event.toJson();
    EXPECT_EQ(j["type"], "ACTIVITY_DELTA");
    EXPECT_EQ(j["messageId"], "msg-789");
    EXPECT_EQ(j["activityType"], "PLAN");
    EXPECT_EQ(j["patch"].size(), 2);
    EXPECT_EQ(j["patch"][0]["op"], "add");
    EXPECT_EQ(j["patch"][1]["op"], "replace");
}

TEST(ActivityEventsTest, ActivityDeltaEventFromJson) {
    nlohmann::json j = {
        {"type", "ACTIVITY_DELTA"},
        {"messageId", "msg-101"},
        {"activityType", "SEARCH"},
        {"patch", {
            {{"op", "add"}, {"path", "/results/0"}, {"value", "result1"}},
            {{"op", "remove"}, {"path", "/temp"}}
        }}
    };

    ActivityDeltaEvent event = ActivityDeltaEvent::fromJson(j);
    EXPECT_EQ(event.messageId, "msg-101");
    EXPECT_EQ(event.activityType, "SEARCH");
    EXPECT_EQ(event.patch.size(), 2);
    EXPECT_EQ(event.patch[0].op, PatchOperation::Add);
    EXPECT_EQ(event.patch[0].path, "/results/0");
    EXPECT_EQ(event.patch[1].op, PatchOperation::Remove);
}

TEST(ActivityEventsTest, ActivityDeltaEventValidation) {
    ActivityDeltaEvent event;

    event.messageId = "msg-123";
    event.activityType = "PLAN";

    // Empty patch must throw
    EXPECT_THROW(event.validate(), AgentError);

    JsonPatchOp op;
    op.op = PatchOperation::Add;
    op.path = "/test";
    op.value = "data";
    event.patch.push_back(op);
    EXPECT_NO_THROW(event.validate());

    // Invalid path (no leading /) triggers validation error
    event.patch[0].path = "invalid_path";
    EXPECT_THROW(event.validate(), AgentError);

    // Valid event
    event.patch[0].path = "/test";
    EXPECT_NO_THROW(event.validate());
}

// EventParser Tests
TEST(ActivityEventsTest, EventParserActivitySnapshot) {
    nlohmann::json j = {
        {"type", "ACTIVITY_SNAPSHOT"},
        {"messageId", "msg-123"},
        {"activityType", "PLAN"},
        {"content", {{"step", 1}}},
        {"replace", true}
    };

    auto event = EventParser::parse(j);
    EXPECT_EQ(event->type(), EventType::ActivitySnapshot);
    
    auto* activityEvent = dynamic_cast<ActivitySnapshotEvent*>(event.get());
    ASSERT_TRUE(activityEvent != nullptr);
    EXPECT_EQ(activityEvent->messageId, "msg-123");
    EXPECT_EQ(activityEvent->activityType, "PLAN");
}

TEST(ActivityEventsTest, EventParserActivityDelta) {
    nlohmann::json j = {
        {"type", "ACTIVITY_DELTA"},
        {"messageId", "msg-456"},
        {"activityType", "SEARCH"},
        {"patch", {
            {{"op", "add"}, {"path", "/count"}, {"value", 10}}
        }}
    };

    auto event = EventParser::parse(j);
    EXPECT_EQ(event->type(), EventType::ActivityDelta);
    
    auto* deltaEvent = static_cast<ActivityDeltaEvent*>(event.get());
    ASSERT_TRUE(deltaEvent != nullptr);
    EXPECT_EQ(deltaEvent->messageId, "msg-456");
    EXPECT_EQ(deltaEvent->activityType, "SEARCH");
    EXPECT_EQ(deltaEvent->patch.size(), 1);
}

TEST(ActivityEventsTest, EventTypeToString) {
    EXPECT_EQ(EventParser::eventTypeToString(EventType::ActivitySnapshot), "ACTIVITY_SNAPSHOT");
    EXPECT_EQ(EventParser::eventTypeToString(EventType::ActivityDelta), "ACTIVITY_DELTA");
}

TEST(ActivityEventsTest, ParseEventType) {
    EXPECT_EQ(EventParser::parseEventType("ACTIVITY_SNAPSHOT"), EventType::ActivitySnapshot);
    EXPECT_EQ(EventParser::parseEventType("ACTIVITY_DELTA"), EventType::ActivityDelta);
}

// Complex Scenarios
TEST(ActivityEventsTest, ActivitySnapshotWithComplexContent) {
    ActivitySnapshotEvent event;
    event.messageId = "msg-complex";
    event.activityType = "ANALYSIS";
    event.content = nlohmann::json{
        {"phase", "data_collection"},
        {"progress", 0.75},
        {"items", nlohmann::json::array({"item1", "item2", "item3"})},
        {"metadata", {{"source", "api"}, {"timestamp", 1234567890}}}
    };
    event.replace = false;

    nlohmann::json j = event.toJson();
    EXPECT_EQ(j["content"]["phase"], "data_collection");
    EXPECT_EQ(j["content"]["progress"], 0.75);
    EXPECT_EQ(j["content"]["items"].size(), 3);
    EXPECT_EQ(j["content"]["metadata"]["source"], "api");
}

TEST(ActivityEventsTest, ActivityDeltaWithMultipleOperations) {
    ActivityDeltaEvent event;
    event.messageId = "msg-multi";
    event.activityType = "PROCESSING";
    
    // Add multiple operations
    JsonPatchOp op1;
    op1.op = PatchOperation::Add;
    op1.path = "/results/-";
    op1.value = "new_result";

    JsonPatchOp op2;
    op2.op = PatchOperation::Replace;
    op2.path = "/status";
    op2.value = "processing";

    JsonPatchOp op3;
    op3.op = PatchOperation::Remove;
    op3.path = "/temp_data";
    
    event.patch.push_back(op1);
    event.patch.push_back(op2);
    event.patch.push_back(op3);
    
    EXPECT_NO_THROW(event.validate());
    
    nlohmann::json j = event.toJson();
    EXPECT_EQ(j["patch"].size(), 3);
    EXPECT_EQ(j["patch"][0]["op"], "add");
    EXPECT_EQ(j["patch"][1]["op"], "replace");
    EXPECT_EQ(j["patch"][2]["op"], "remove");
}
