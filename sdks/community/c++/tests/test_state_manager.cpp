#include "core/state.h"
#include <cassert>
#include <iostream>
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

#define EXPECT_THROW(statement) \
    { \
        bool threw = false; \
        try { \
            statement; \
        } catch (...) { \
            threw = true; \
        } \
        if (!threw) { \
            throw std::runtime_error("Expected exception but none was thrown"); \
        } \
    }

// ============================================================================
// Add Operation Tests
// ============================================================================

TEST_CASE(AddToEmptyObject) {
    StateManager manager;
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/name"},
        {"value", "test"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("name"));
    EXPECT_EQ(manager.currentState()["name"], "test");
}

TEST_CASE(AddToExistingObject) {
    nlohmann::json initialState = {{"existing", "value"}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/newField"},
        {"value", 42}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("existing"));
    ASSERT_TRUE(manager.currentState().contains("newField"));
    EXPECT_EQ(manager.currentState()["newField"], 42);
}

TEST_CASE(AddToArray) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/arr/1"},
        {"value", 99}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 4);
    EXPECT_EQ(arr[0], 1);
    EXPECT_EQ(arr[1], 99);
    EXPECT_EQ(arr[2], 2);
    EXPECT_EQ(arr[3], 3);
}

TEST_CASE(AddToArrayWithDashIndex) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/arr/-"},
        {"value", 4}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 4);
    EXPECT_EQ(arr[3], 4);
}

TEST_CASE(AddNestedPath) {
    StateManager manager;
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "add"},
        {"path", "/user/profile/name"},
        {"value", "John"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("user"));
    ASSERT_TRUE(manager.currentState()["user"].contains("profile"));
    ASSERT_TRUE(manager.currentState()["user"]["profile"].contains("name"));
    EXPECT_EQ(manager.currentState()["user"]["profile"]["name"], "John");
}

// ============================================================================
// Remove Operation Tests
// ============================================================================

TEST_CASE(RemoveObjectProperty) {
    nlohmann::json initialState = {{"a", 1}, {"b", 2}, {"c", 3}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/b"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("a"));
    ASSERT_FALSE(manager.currentState().contains("b"));
    ASSERT_TRUE(manager.currentState().contains("c"));
}

TEST_CASE(RemoveArrayElement) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3, 4})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/arr/1"}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 3);
    EXPECT_EQ(arr[0], 1);
    EXPECT_EQ(arr[1], 3);
    EXPECT_EQ(arr[2], 4);
}

TEST_CASE(RemoveNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/nonexistent"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

TEST_CASE(RemoveRoot) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

// ============================================================================
// Replace Operation Tests
// ============================================================================

TEST_CASE(ReplaceObjectProperty) {
    nlohmann::json initialState = {{"name", "old"}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/name"},
        {"value", "new"}
    });
    
    manager.applyPatch(patch);
    
    EXPECT_EQ(manager.currentState()["name"], "new");
}

TEST_CASE(ReplaceArrayElement) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/arr/1"},
        {"value", 99}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr[1], 99);
}

TEST_CASE(ReplaceRoot) {
    nlohmann::json initialState = {{"old", "state"}};
    StateManager manager(initialState);
    
    nlohmann::json newState = {{"new", "state"}};
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/"},
        {"value", newState}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_FALSE(manager.currentState().contains("old"));
    ASSERT_TRUE(manager.currentState().contains("new"));
    EXPECT_EQ(manager.currentState()["new"], "state");
}

TEST_CASE(ReplaceNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/nonexistent"},
        {"value", "test"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

// ============================================================================
// Move Operation Tests
// ============================================================================

TEST_CASE(MoveObjectProperty) {
    nlohmann::json initialState = {{"a", 1}, {"b", 2}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "move"},
        {"from", "/a"},
        {"path", "/c"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_FALSE(manager.currentState().contains("a"));
    ASSERT_TRUE(manager.currentState().contains("b"));
    ASSERT_TRUE(manager.currentState().contains("c"));
    EXPECT_EQ(manager.currentState()["c"], 1);
}

TEST_CASE(MoveArrayElement) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3, 4})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "move"},
        {"from", "/arr/0"},
        {"path", "/arr/3"}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 4);
    EXPECT_EQ(arr[3], 1);
}

TEST_CASE(MoveToNewLocation) {
    nlohmann::json initialState = {{"source", {"value", 42}}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "move"},
        {"from", "/source"},
        {"path", "/destination"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_FALSE(manager.currentState().contains("source"));
    ASSERT_TRUE(manager.currentState().contains("destination"));
}

TEST_CASE(MoveNonExistentSource) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "move"},
        {"from", "/nonexistent"},
        {"path", "/b"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

// ============================================================================
// Copy Operation Tests
// ============================================================================

TEST_CASE(CopyObjectProperty) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "copy"},
        {"from", "/a"},
        {"path", "/b"}
    });
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("a"));
    ASSERT_TRUE(manager.currentState().contains("b"));
    EXPECT_EQ(manager.currentState()["a"], 1);
    EXPECT_EQ(manager.currentState()["b"], 1);
}

TEST_CASE(CopyArrayElement) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "copy"},
        {"from", "/arr/0"},
        {"path", "/arr/-"}
    });
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 4);
    EXPECT_EQ(arr[0], 1);
    EXPECT_EQ(arr[3], 1);
}

TEST_CASE(CopyNonExistentSource) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "copy"},
        {"from", "/nonexistent"},
        {"path", "/b"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

// ============================================================================
// Test Operation Tests
// ============================================================================

TEST_CASE(TestValueMatch) {
    nlohmann::json initialState = {{"value", 42}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/value"},
        {"value", 42}
    });
    
    // Should not throw exception
    manager.applyPatch(patch);
}

TEST_CASE(TestValueMismatch) {
    nlohmann::json initialState = {{"value", 42}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/value"},
        {"value", 99}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

TEST_CASE(TestNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/nonexistent"},
        {"value", "test"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch));
}

// ============================================================================
// Path Parsing Tests
// ============================================================================

TEST_CASE(ParseSimplePath) {
    nlohmann::json initialState = {{"a", {{"b", {{"c", 123}}}}}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/a/b/c"},
        {"value", 456}
    });
    
    manager.applyPatch(patch);
    
    EXPECT_EQ(manager.currentState()["a"]["b"]["c"], 456);
}

TEST_CASE(ParsePathWithEscaping) {
    nlohmann::json initialState = {{"a~b", 1}, {"c/d", 2}};
    StateManager manager(initialState);
    
    // ~0 represents ~, ~1 represents /
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/a~0b"},
        {"value", 99}
    });
    
    manager.applyPatch(patch);
    
    EXPECT_EQ(manager.currentState()["a~b"], 99);
}

TEST_CASE(ParseArrayIndexPath) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({10, 20, 30})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/arr/0"},
        {"value", 100}
    });
    
    manager.applyPatch(patch);
    
    EXPECT_EQ(manager.currentState()["arr"][0], 100);
}

// ============================================================================
// History and Rollback Tests
// ============================================================================

TEST_CASE(EnableHistoryTracking) {
    StateManager manager;
    manager.enableHistory(true, 5);
    
    nlohmann::json patch1 = nlohmann::json::array();
    patch1.push_back({{"op", "add"}, {"path", "/a"}, {"value", 1}});
    manager.applyPatch(patch1);
    
    nlohmann::json patch2 = nlohmann::json::array();
    patch2.push_back({{"op", "add"}, {"path", "/b"}, {"value", 2}});
    manager.applyPatch(patch2);
    
    EXPECT_EQ(manager.historySize(), 2);
}

TEST_CASE(RollbackToPreviousState) {
    StateManager manager;
    manager.enableHistory(true);
    
    nlohmann::json patch1 = nlohmann::json::array();
    patch1.push_back({{"op", "add"}, {"path", "/a"}, {"value", 1}});
    manager.applyPatch(patch1);
    
    nlohmann::json patch2 = nlohmann::json::array();
    patch2.push_back({{"op", "add"}, {"path", "/b"}, {"value", 2}});
    manager.applyPatch(patch2);
    
    ASSERT_TRUE(manager.currentState().contains("a"));
    ASSERT_TRUE(manager.currentState().contains("b"));
    
    bool rolled = manager.rollback();
    ASSERT_TRUE(rolled);
    
    ASSERT_TRUE(manager.currentState().contains("a"));
    ASSERT_FALSE(manager.currentState().contains("b"));
}

TEST_CASE(MultipleRollbacks) {
    StateManager manager;
    manager.enableHistory(true);
    
    for (int i = 0; i < 3; i++) {
        nlohmann::json patch = nlohmann::json::array();
        patch.push_back({{"op", "add"}, {"path", "/v" + std::to_string(i)}, {"value", i}});
        manager.applyPatch(patch);
    }
    
    EXPECT_EQ(manager.historySize(), 3);
    
    manager.rollback();
    ASSERT_FALSE(manager.currentState().contains("v2"));
    
    manager.rollback();
    ASSERT_FALSE(manager.currentState().contains("v1"));
    
    manager.rollback();
    ASSERT_FALSE(manager.currentState().contains("v0"));
}

TEST_CASE(HistorySizeLimit) {
    StateManager manager;
    manager.enableHistory(true, 3);
    
    for (int i = 0; i < 5; i++) {
        nlohmann::json patch = nlohmann::json::array();
        patch.push_back({{"op", "add"}, {"path", "/v" + std::to_string(i)}, {"value", i}});
        manager.applyPatch(patch);
    }
    
    // Should only keep last 3 history entries
    EXPECT_EQ(manager.historySize(), 3);
}

// ============================================================================
// Batch Patch Tests
// ============================================================================

TEST_CASE(ApplyMultiplePatchOperations) {
    StateManager manager;
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({{"op", "add"}, {"path", "/a"}, {"value", 1}});
    patch.push_back({{"op", "add"}, {"path", "/b"}, {"value", 2}});
    patch.push_back({{"op", "add"}, {"path", "/c"}, {"value", 3}});
    
    manager.applyPatch(patch);
    
    ASSERT_TRUE(manager.currentState().contains("a"));
    ASSERT_TRUE(manager.currentState().contains("b"));
    ASSERT_TRUE(manager.currentState().contains("c"));
    EXPECT_EQ(manager.currentState()["a"], 1);
    EXPECT_EQ(manager.currentState()["b"], 2);
    EXPECT_EQ(manager.currentState()["c"], 3);
}

TEST_CASE(PatchArrayWithMultipleOps) {
    nlohmann::json initialState = {{"arr", nlohmann::json::array({1, 2, 3})}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({{"op", "add"}, {"path", "/arr/-"}, {"value", 4}});
    patch.push_back({{"op", "replace"}, {"path", "/arr/0"}, {"value", 10}});
    patch.push_back({{"op", "remove"}, {"path", "/arr/1"}});
    
    manager.applyPatch(patch);
    
    auto arr = manager.currentState()["arr"];
    EXPECT_EQ(arr.size(), 3);
    EXPECT_EQ(arr[0], 10);
}

// ============================================================================
// Snapshot and Restore Tests
// ============================================================================

TEST_CASE(CreateSnapshot) {
    nlohmann::json initialState = {{"a", 1}, {"b", 2}};
    StateManager manager(initialState);
    
    nlohmann::json snapshot = manager.createSnapshot();
    
    EXPECT_EQ(snapshot["a"], 1);
    EXPECT_EQ(snapshot["b"], 2);
}

TEST_CASE(RestoreFromSnapshot) {
    StateManager manager;
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({{"op", "add"}, {"path", "/a"}, {"value", 1}});
    manager.applyPatch(patch);
    
    nlohmann::json snapshot = {{"restored", "state"}};
    manager.restoreFromSnapshot(snapshot);
    
    ASSERT_FALSE(manager.currentState().contains("a"));
    ASSERT_TRUE(manager.currentState().contains("restored"));
    EXPECT_EQ(manager.currentState()["restored"], "state");
}

// ============================================================================
// Validation Tests
// ============================================================================

TEST_CASE(ValidateState) {
    nlohmann::json validState = {{"a", 1}};
    StateManager manager(validState);
    
    ASSERT_TRUE(manager.validateState());
}

TEST_CASE(ValidateEmptyState) {
    StateManager manager;
    
    ASSERT_TRUE(manager.validateState());
}

// ============================================================================
// Main function
// ============================================================================

int main() {
    std::cout << "\n========================================" << std::endl;
    std::cout << "StateManager Test Suite" << std::endl;
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