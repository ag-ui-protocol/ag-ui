/**
 * @file test_state_manager.cpp
 * @brief StateManager functionality tests
 * 
 * Tests JSON Patch operations, path parsing, history tracking and state management
 */

#include <gtest/gtest.h>
#include <string>

#include "core/state.h"

using namespace agui;

// Validation Tests
TEST(StateManagerTest, ValidateEmptyState) {
    StateManager manager;
    
    // m_currentState default set to nlohmann::json::object
    ASSERT_TRUE(manager.validateState());
}

TEST(StateManagerTest, ValidateState) {
    nlohmann::json validState = {{"a", 1}};
    StateManager manager(validState);
    
    ASSERT_TRUE(manager.validateState());
}

// Add Operation Tests
TEST(StateManagerTest, AddToEmptyObject) {
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

TEST(StateManagerTest, AddToExistingObject) {
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

TEST(StateManagerTest, AddToArray) {
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

TEST(StateManagerTest, AddToArrayWithDashIndex) {
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

TEST(StateManagerTest, AddNestedPath) {
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

// Remove Operation Tests
TEST(StateManagerTest, RemoveObjectProperty) {
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

TEST(StateManagerTest, RemoveArrayElement) {
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

TEST(StateManagerTest, RemoveNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/nonexistent"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

TEST(StateManagerTest, RemoveRoot) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

// Replace Operation Tests
TEST(StateManagerTest, ReplaceObjectProperty) {
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

TEST(StateManagerTest, ReplaceArrayElement) {
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

TEST(StateManagerTest, ReplaceRoot) {
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

TEST(StateManagerTest, ReplaceNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/nonexistent"},
        {"value", "test"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

// Move Operation Tests
TEST(StateManagerTest, MoveObjectProperty) {
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

TEST(StateManagerTest, MoveArrayElement) {
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

TEST(StateManagerTest, MoveToNewLocation) {
    nlohmann::json initialState = {{"source", nlohmann::json{{"value", 42}}}};
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

TEST(StateManagerTest, MoveNonExistentSource) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "move"},
        {"from", "/nonexistent"},
        {"path", "/b"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

// Copy Operation Tests
TEST(StateManagerTest, CopyObjectProperty) {
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

TEST(StateManagerTest, CopyArrayElement) {
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

TEST(StateManagerTest, CopyNonExistentSource) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "copy"},
        {"from", "/nonexistent"},
        {"path", "/b"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

// Test Operation Tests
TEST(StateManagerTest, TestValueMatch) {
    nlohmann::json initialState = {{"value", 42}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/value"},
        {"value", 42}
    });
    
    // Should not throw exception
    EXPECT_NO_THROW(manager.applyPatch(patch));
}

TEST(StateManagerTest, TestValueMismatch) {
    nlohmann::json initialState = {{"value", 42}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/value"},
        {"value", 99}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

TEST(StateManagerTest, TestNonExistentPath) {
    nlohmann::json initialState = {{"a", 1}};
    StateManager manager(initialState);
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "test"},
        {"path", "/nonexistent"},
        {"value", "test"}
    });
    
    EXPECT_THROW(manager.applyPatch(patch), std::exception);
}

// Path Parsing Tests
TEST(StateManagerTest, ParseSimplePath) {
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

TEST(StateManagerTest, ParsePathWithEscaping) {
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

TEST(StateManagerTest, ParseArrayIndexPath) {
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

// History and Rollback Tests
TEST(StateManagerTest, EnableHistoryTracking) {
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

TEST(StateManagerTest, RollbackToPreviousState) {
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

TEST(StateManagerTest, MultipleRollbacks) {
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

TEST(StateManagerTest, HistorySizeLimit) {
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

// Batch Patch Tests
TEST(StateManagerTest, ApplyMultiplePatchOperations) {
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

TEST(StateManagerTest, PatchArrayWithMultipleOps) {
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

// Snapshot and Restore Tests
TEST(StateManagerTest, CreateSnapshot) {
    nlohmann::json initialState = {{"a", 1}, {"b", 2}};
    StateManager manager(initialState);
    
    nlohmann::json snapshot = manager.createSnapshot();
    
    EXPECT_EQ(snapshot["a"], 1);
    EXPECT_EQ(snapshot["b"], 2);
}

TEST(StateManagerTest, RestoreFromSnapshot) {
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
