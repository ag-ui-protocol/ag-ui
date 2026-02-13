#include "apply/apply.h"
#include "core/session_types.h"
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

#define EXPECT_NULL(ptr) \
    if ((ptr) != nullptr) { \
        throw std::runtime_error("Expected null pointer"); \
    }

#define EXPECT_NOT_NULL(ptr) \
    if ((ptr) == nullptr) { \
        throw std::runtime_error("Expected non-null pointer"); \
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
// Message Finding Tests
// ============================================================================

TEST_CASE(FindMessageById) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("Hi there"));
    messages.push_back(Message::createUser("How are you?"));
    
    // Get the ID of the second message
    MessageId targetId = messages[1].id();
    
    Message* found = ApplyModule::findMessageById(messages, targetId);
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->content(), "Hi there");
}

TEST_CASE(FindMessageByIdNotFound) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    
    MessageId nonExistentId = "nonexistent-id";
    
    Message* found = ApplyModule::findMessageById(messages, nonExistentId);
    EXPECT_NULL(found);
}

TEST_CASE(FindMessageByIdEmptyList) {
    std::vector<Message> messages;
    
    MessageId anyId = "any-id";
    
    Message* found = ApplyModule::findMessageById(messages, anyId);
    EXPECT_NULL(found);
}

TEST_CASE(FindMessageByIdConst) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Test"));
    
    const std::vector<Message>& constMessages = messages;
    MessageId targetId = messages[0].id();
    
    const Message* found = ApplyModule::findMessageById(constMessages, targetId);
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->content(), "Test");
}

TEST_CASE(FindLastAssistantMessage) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("First response"));
    messages.push_back(Message::createUser("Another question"));
    messages.push_back(Message::createAssistant("Second response"));
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->content(), "Second response");
}

TEST_CASE(FindLastAssistantMessageNoAssistant) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createUser("Another message"));
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NULL(found);
}

TEST_CASE(FindLastAssistantMessageEmptyList) {
    std::vector<Message> messages;
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NULL(found);
}

TEST_CASE(FindLastAssistantMessageOnlyAssistant) {
    std::vector<Message> messages;
    messages.push_back(Message::createAssistant("Only message"));
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->content(), "Only message");
}

// ============================================================================
// Tool Call Finding Tests
// ============================================================================

TEST_CASE(FindToolCallById) {
    Message message = Message::createAssistant("");
    
    ToolCall toolCall1;
    toolCall1.id = "call1";
    toolCall1.function.name = "search";
    toolCall1.function.arguments = "{\"query\":\"test\"}";
    
    ToolCall toolCall2;
    toolCall2.id = "call2";
    toolCall2.function.name = "calculate";
    toolCall2.function.arguments = "{\"expr\":\"1+1\"}";
    
    message.addToolCall(toolCall1);
    message.addToolCall(toolCall2);
    
    const ToolCall* found = ApplyModule::findToolCallById(message, "call2");
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->function.name, "calculate");
}

TEST_CASE(FindToolCallByIdNotFound) {
    Message message = Message::createAssistant("");
    
    ToolCall toolCall;
    toolCall.id = "call1";
    toolCall.function.name = "test";
    message.addToolCall(toolCall);
    
    const ToolCall* found = ApplyModule::findToolCallById(message, "nonexistent");
    EXPECT_NULL(found);
}

TEST_CASE(FindToolCallByIdNoToolCalls) {
    Message message = Message::createAssistant("Just text");
    
    const ToolCall* found = ApplyModule::findToolCallById(message, "any-id");
    EXPECT_NULL(found);
}

TEST_CASE(FindToolCallByIdConst) {
    Message message = Message::createAssistant("");
    
    ToolCall toolCall;
    toolCall.id = "call1";
    toolCall.function.name = "test";
    message.addToolCall(toolCall);
    
    const Message& constMessage = message;
    const ToolCall* found = ApplyModule::findToolCallById(constMessage, "call1");
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->function.name, "test");
}

// ============================================================================
// JSON Patch Application Tests
// ============================================================================

TEST_CASE(ApplyJsonPatchSuccess) {
    nlohmann::json state = {{"count", 0}};
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "replace"},
        {"path", "/count"},
        {"value", 1}
    });
    
    ApplyModule::applyJsonPatch(state, patch);
    
    EXPECT_EQ(state["count"], 1);
}

TEST_CASE(ApplyJsonPatchMultipleOps) {
    nlohmann::json state = {{"a", 1}};
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({{"op", "add"}, {"path", "/b"}, {"value", 2}});
    patch.push_back({{"op", "add"}, {"path", "/c"}, {"value", 3}});
    
    ApplyModule::applyJsonPatch(state, patch);
    
    ASSERT_TRUE(state.contains("a"));
    ASSERT_TRUE(state.contains("b"));
    ASSERT_TRUE(state.contains("c"));
    EXPECT_EQ(state["b"], 2);
    EXPECT_EQ(state["c"], 3);
}

TEST_CASE(ApplyJsonPatchInvalid) {
    nlohmann::json state = {{"a", 1}};
    
    // Invalid patch: trying to remove non-existent path
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({
        {"op", "remove"},
        {"path", "/nonexistent"}
    });
    
    EXPECT_THROW(ApplyModule::applyJsonPatch(state, patch));
}

TEST_CASE(ApplyJsonPatchEmptyPatch) {
    nlohmann::json state = {{"a", 1}};
    nlohmann::json originalState = state;
    
    nlohmann::json patch = nlohmann::json::array();
    
    ApplyModule::applyJsonPatch(state, patch);
    
    // State should remain unchanged
    EXPECT_EQ(state, originalState);
}

// ============================================================================
// State Validation Tests
// ============================================================================

TEST_CASE(ValidateStateObject) {
    nlohmann::json state = {{"key", "value"}};
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

TEST_CASE(ValidateStateNull) {
    nlohmann::json state = nullptr;
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

TEST_CASE(ValidateStateEmptyObject) {
    nlohmann::json state = nlohmann::json::object();
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

TEST_CASE(ValidateStateInvalidArray) {
    nlohmann::json state = nlohmann::json::array({1, 2, 3});
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST_CASE(ValidateStateInvalidString) {
    nlohmann::json state = "not an object";
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST_CASE(ValidateStateInvalidNumber) {
    nlohmann::json state = 42;
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

// ============================================================================
// Message Creation Tests
// ============================================================================

TEST_CASE(CreateAssistantMessageWithId) {
    MessageId customId = "custom-message-id";
    
    Message message = ApplyModule::createAssistantMessage(customId);
    
    EXPECT_EQ(message.id(), customId);
    EXPECT_EQ(message.role(), MessageRole::Assistant);
    EXPECT_EQ(message.content(), "");
}

TEST_CASE(CreateAssistantMessageDifferentIds) {
    MessageId id1 = "id-1";
    MessageId id2 = "id-2";
    
    Message message1 = ApplyModule::createAssistantMessage(id1);
    Message message2 = ApplyModule::createAssistantMessage(id2);
    
    EXPECT_EQ(message1.id(), id1);
    EXPECT_EQ(message2.id(), id2);
    ASSERT_FALSE(message1.id() == message2.id());
}

TEST_CASE(CreateToolMessage) {
    ToolCallId toolCallId = "call-123";
    std::string content = "{\"result\": \"success\"}";
    
    Message message = ApplyModule::createToolMessage(toolCallId, content);
    
    EXPECT_EQ(message.role(), MessageRole::Tool);
    EXPECT_EQ(message.content(), content);
    EXPECT_EQ(message.toolCallId(), toolCallId);
}

TEST_CASE(CreateToolMessageEmptyContent) {
    ToolCallId toolCallId = "call-456";
    std::string content = "";
    
    Message message = ApplyModule::createToolMessage(toolCallId, content);
    
    EXPECT_EQ(message.role(), MessageRole::Tool);
    EXPECT_EQ(message.content(), "");
    EXPECT_EQ(message.toolCallId(), toolCallId);
}

// ============================================================================
// Integration Tests
// ============================================================================

TEST_CASE(FindAndModifyMessage) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("Hi"));
    
    MessageId targetId = messages[1].id();
    Message* found = ApplyModule::findMessageById(messages, targetId);
    
    EXPECT_NOT_NULL(found);
    
    // Modify the found message
    found->appendContent(" there!");
    
    EXPECT_EQ(messages[1].content(), "Hi there!");
}

TEST_CASE(FindAndModifyToolCall) {
    Message message = Message::createAssistant("");
    
    ToolCall toolCall;
    toolCall.id = "call1";
    toolCall.function.name = "test";
    toolCall.function.arguments = "";
    message.addToolCall(toolCall);
    
    message.appendEventDelta("call1", "{\"updated\":true}");
    
    const ToolCall* verified = ApplyModule::findToolCallById(message, "call1");
    EXPECT_EQ(verified->function.arguments, "{\"updated\":true}");
}

TEST_CASE(CreateAndFindMessage) {
    std::vector<Message> messages;
    
    MessageId customId = "test-id";
    Message newMessage = ApplyModule::createAssistantMessage(customId);
    messages.push_back(newMessage);
    
    Message* found = ApplyModule::findMessageById(messages, customId);
    EXPECT_NOT_NULL(found);
    EXPECT_EQ(found->id(), customId);
}

TEST_CASE(MultipleMessageOperations) {
    std::vector<Message> messages;
    
    // Add user message
    messages.push_back(Message::createUser("Question"));
    
    // Add assistant message with custom ID
    MessageId assistantId = "assistant-1";
    messages.push_back(ApplyModule::createAssistantMessage(assistantId));
    
    // Find and modify assistant message
    Message* assistant = ApplyModule::findMessageById(messages, assistantId);
    EXPECT_NOT_NULL(assistant);
    assistant->appendContent("Answer");
    
    // Add tool call to assistant message
    ToolCall toolCall;
    toolCall.id = "call1";
    toolCall.function.name = "search";
    assistant->addToolCall(toolCall);
    
    // Add tool result message
    messages.push_back(ApplyModule::createToolMessage("call1", "Result"));
    
    // Verify structure
    EXPECT_EQ(messages.size(), 3);
    EXPECT_EQ(messages[0].role(), MessageRole::User);
    EXPECT_EQ(messages[1].role(), MessageRole::Assistant);
    EXPECT_EQ(messages[2].role(), MessageRole::Tool);
    
    // Find last assistant message
    Message* lastAssistant = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NOT_NULL(lastAssistant);
    EXPECT_EQ(lastAssistant->id(), assistantId);
}

// ============================================================================
// Edge Cases
// ============================================================================

TEST_CASE(FindMessageWithEmptyId) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Test"));
    
    MessageId emptyId = "";
    Message* found = ApplyModule::findMessageById(messages, emptyId);
    
    // Should not find message with empty ID
    EXPECT_NULL(found);
}

TEST_CASE(ApplyPatchToEmptyState) {
    nlohmann::json state = nlohmann::json::object();
    
    nlohmann::json patch = nlohmann::json::array();
    patch.push_back({{"op", "add"}, {"path", "/newField"}, {"value", "test"}});
    
    ApplyModule::applyJsonPatch(state, patch);
    
    ASSERT_TRUE(state.contains("newField"));
    EXPECT_EQ(state["newField"], "test");
}

TEST_CASE(ValidateComplexState) {
    nlohmann::json state = {
        {"user", {
            {"name", "John"},
            {"age", 30},
            {"preferences", {
                {"theme", "dark"},
                {"language", "en"}
            }}
        }},
        {"session", {
            {"id", "session-123"},
            {"active", true}
        }}
    };
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

// ============================================================================
// Main function
// ============================================================================

int main() {
    std::cout << "\n========================================" << std::endl;
    std::cout << "ApplyModule Test Suite" << std::endl;
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
