#include "core/event.h"
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

#define EXPECT_THROW(statement, exception_type) \
    { \
        bool caught = false; \
        try { \
            statement; \
        } catch (const exception_type&) { \
            caught = true; \
        } catch (...) { \
        } \
        if (!caught) { \
            throw std::runtime_error("Expected exception not thrown: " #exception_type); \
        } \
    }

#define EXPECT_NO_THROW(statement) \
    try { \
        statement; \
    } catch (const std::exception& e) { \
        throw std::runtime_error(std::string("Unexpected exception: ") + e.what()); \
    }

// ============================================================================
// ActivitySnapshotEvent Tests
// ============================================================================

TEST_CASE(ActivitySnapshotEventBasic) {
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

TEST_CASE(ActivitySnapshotEventFromJson) {
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

TEST_CASE(ActivitySnapshotEventValidation) {
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

// ============================================================================
// JsonPatchOperation Tests
// ============================================================================

TEST_CASE(JsonPatchOperationBasic) {
    JsonPatchOperation op;
    op.op = "add";
    op.path = "/status";
    op.value = "completed";

    nlohmann::json j = op.toJson();
    EXPECT_EQ(j["op"], "add");
    EXPECT_EQ(j["path"], "/status");
    EXPECT_EQ(j["value"], "completed");
}

TEST_CASE(JsonPatchOperationValidation) {
    JsonPatchOperation op;
    
    // Invalid operation
    op.op = "invalid";
    op.path = "/test";
    EXPECT_THROW(op.validate(), AgentError);
    
    // Invalid path (doesn't start with /)
    op.op = "add";
    op.path = "test";
    EXPECT_THROW(op.validate(), AgentError);
    
    // move operation without from
    op.op = "move";
    op.path = "/new";
    EXPECT_THROW(op.validate(), AgentError);
    
    // add operation without value
    op.op = "add";
    op.path = "/test";
    op.value = nlohmann::json();
    EXPECT_THROW(op.validate(), AgentError);
    
    // Valid add operation
    op.value = "test";
    EXPECT_NO_THROW(op.validate());
    
    // Valid move operation
    op.op = "move";
    op.from = "/old";
    op.value = nlohmann::json();
    EXPECT_NO_THROW(op.validate());
}

TEST_CASE(JsonPatchOperationAllTypes) {
    // Test all 6 operation types
    std::vector<std::string> validOps = {"add", "remove", "replace", "move", "copy", "test"};
    
    for (const auto& opType : validOps) {
        JsonPatchOperation op;
        op.op = opType;
        op.path = "/test";
        
        if (opType == "move" || opType == "copy") {
            op.from = "/source";
        } else if (opType != "remove") {
            op.value = "value";
        }
        
        EXPECT_NO_THROW(op.validate());
    }
}

// ============================================================================
// ActivityDeltaEvent Tests
// ============================================================================

TEST_CASE(ActivityDeltaEventBasic) {
    ActivityDeltaEvent event;
    event.messageId = "msg-789";
    event.activityType = "PLAN";
    
    JsonPatchOperation op1;
    op1.op = "add";
    op1.path = "/step";
    op1.value = 2;
    
    JsonPatchOperation op2;
    op2.op = "replace";
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

TEST_CASE(ActivityDeltaEventFromJson) {
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
    EXPECT_EQ(event.patch[0].op, "add");
    EXPECT_EQ(event.patch[0].path, "/results/0");
    EXPECT_EQ(event.patch[1].op, "remove");
}

TEST_CASE(ActivityDeltaEventValidation) {
    ActivityDeltaEvent event;
    
    // Missing messageId
    event.activityType = "PLAN";
    JsonPatchOperation op;
    op.op = "add";
    op.path = "/test";
    op.value = "data";
    event.patch.push_back(op);
    EXPECT_THROW(event.validate(), AgentError);
    
    // Missing activityType
    event.messageId = "msg-123";
    event.activityType = "";
    EXPECT_THROW(event.validate(), AgentError);
    
    // Empty patch
    event.activityType = "PLAN";
    event.patch.clear();
    EXPECT_THROW(event.validate(), AgentError);
    
    // Invalid patch operation
    event.patch.push_back(op);
    event.patch[0].op = "invalid";
    EXPECT_THROW(event.validate(), AgentError);
    
    // Valid event
    event.patch[0].op = "add";
    EXPECT_NO_THROW(event.validate());
}

// ============================================================================
// EventParser Tests
// ============================================================================

TEST_CASE(EventParserActivitySnapshot) {
    nlohmann::json j = {
        {"type", "ACTIVITY_SNAPSHOT"},
        {"messageId", "msg-123"},
        {"activityType", "PLAN"},
        {"content", {{"step", 1}}},
        {"replace", true}
    };

    auto event = EventParser::parse(j);
    EXPECT_EQ(event->type(), EventType::ActivitySnapshot);
    
    auto* activityEvent = static_cast<ActivitySnapshotEvent*>(event.get());
    ASSERT_TRUE(activityEvent != nullptr);
    EXPECT_EQ(activityEvent->messageId, "msg-123");
    EXPECT_EQ(activityEvent->activityType, "PLAN");
}

TEST_CASE(EventParserActivityDelta) {
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

TEST_CASE(EventTypeToString) {
    EXPECT_EQ(EventParser::eventTypeToString(EventType::ActivitySnapshot), "ACTIVITY_SNAPSHOT");
    EXPECT_EQ(EventParser::eventTypeToString(EventType::ActivityDelta), "ACTIVITY_DELTA");
}

TEST_CASE(ParseEventType) {
    EXPECT_EQ(EventParser::parseEventType("ACTIVITY_SNAPSHOT"), EventType::ActivitySnapshot);
    EXPECT_EQ(EventParser::parseEventType("ACTIVITY_DELTA"), EventType::ActivityDelta);
}

// ============================================================================
// Complex Scenarios
// ============================================================================

TEST_CASE(ActivitySnapshotWithComplexContent) {
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

TEST_CASE(ActivityDeltaWithMultipleOperations) {
    ActivityDeltaEvent event;
    event.messageId = "msg-multi";
    event.activityType = "PROCESSING";
    
    // Add multiple operations
    JsonPatchOperation op1;
    op1.op = "add";
    op1.path = "/results/-";
    op1.value = "new_result";
    
    JsonPatchOperation op2;
    op2.op = "replace";
    op2.path = "/status";
    op2.value = "processing";
    
    JsonPatchOperation op3;
    op3.op = "remove";
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

// ============================================================================
// Main function
// ============================================================================

int main() {
    std::cout << "\n========================================" << std::endl;
    std::cout << "Activity Events Test Suite" << std::endl;
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