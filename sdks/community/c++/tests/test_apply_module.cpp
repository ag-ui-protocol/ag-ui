/**
 * @file test_apply_module.cpp
 * @brief ApplyModule functionality tests
 * 
 * Tests message finding, tool call finding, JSON patch application and state validation
 */

#include <gtest/gtest.h>
#include <string>

#include "apply/apply.h"
#include "core/session_types.h"

using namespace agui;

// Message Finding Tests
TEST(ApplyModuleTest, FindMessageById) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("Hi there"));
    messages.push_back(Message::createUser("How are you?"));
    
    // Get the ID of the second message
    MessageId targetId = messages[1].id();
    
    Message* found = ApplyModule::findMessageById(messages, targetId);
    EXPECT_NE(found, nullptr);
    EXPECT_EQ(found->content(), "Hi there");
}

TEST(ApplyModuleTest, FindMessageByIdNotFound) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    
    MessageId nonExistentId = "nonexistent-id";
    
    Message* found = ApplyModule::findMessageById(messages, nonExistentId);
    EXPECT_EQ(found, nullptr);
}

TEST(ApplyModuleTest, FindMessageByIdConst) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Test"));
    
    const std::vector<Message>& constMessages = messages;
    MessageId targetId = messages[0].id();
    
    const Message* found = ApplyModule::findMessageById(constMessages, targetId);
    EXPECT_NE(found, nullptr);
    EXPECT_EQ(found->content(), "Test");
}

TEST(ApplyModuleTest, FindLastAssistantMessage) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("First response"));
    messages.push_back(Message::createUser("Another question"));
    messages.push_back(Message::createAssistant("Second response"));
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_NE(found, nullptr);
    EXPECT_EQ(found->content(), "Second response");
}

TEST(ApplyModuleTest, FindLastAssistantMessageNoAssistant) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createUser("Another message"));
    
    Message* found = ApplyModule::findLastAssistantMessage(messages);
    EXPECT_EQ(found, nullptr);
}

// Tool Call Finding Tests
TEST(ApplyModuleTest, FindToolCallById) {
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
    EXPECT_NE(found, nullptr);
    EXPECT_EQ(found->function.name, "calculate");
}

TEST(ApplyModuleTest, FindToolCallByIdNotFound) {
    Message message = Message::createAssistant("");
    
    ToolCall toolCall;
    toolCall.id = "call1";
    toolCall.function.name = "test";
    message.addToolCall(toolCall);
    
    const ToolCall* found = ApplyModule::findToolCallById(message, "nonexistent");
    EXPECT_EQ(found, nullptr);
}

// JSON Patch Application Tests
TEST(ApplyModuleTest, ApplyJsonPatchMultipleOps) {
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

TEST(ApplyModuleTest, ApplyJsonPatchEmptyPatch) {
    nlohmann::json state = {{"a", 1}};
    nlohmann::json originalState = state;
    
    nlohmann::json patch = nlohmann::json::array();
    
    ApplyModule::applyJsonPatch(state, patch);
    
    // State should remain unchanged
    EXPECT_EQ(state, originalState);
}

// State Validation Tests
TEST(ApplyModuleTest, ValidateStateObject) {
    nlohmann::json state = {{"key", "value"}};
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, ValidateStateNull) {
    nlohmann::json state = nullptr;
    
    // Null state is not allowed, should return false
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, ValidateStateEmptyObject) {
    nlohmann::json state = nlohmann::json::object();
    
    ASSERT_TRUE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, ValidateStateInvalidArray) {
    nlohmann::json state = nlohmann::json::array({1, 2, 3});
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, ValidateStateInvalidString) {
    nlohmann::json state = "not an object";
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, ValidateStateInvalidNumber) {
    nlohmann::json state = 42;
    
    ASSERT_FALSE(ApplyModule::validateState(state));
}

TEST(ApplyModuleTest, CreateAssistantMessageDifferentIds) {
    MessageId id1 = "id-1";
    MessageId id2 = "id-2";
    
    Message message1 = ApplyModule::createAssistantMessage(id1);
    Message message2 = ApplyModule::createAssistantMessage(id2);
    
    EXPECT_EQ(message1.id(), id1);
    EXPECT_EQ(message2.id(), id2);
    EXPECT_EQ(message1.role(), MessageRole::Assistant);
}

TEST(ApplyModuleTest, CreateToolMessage) {
    ToolCallId toolCallId = "call-123";
    std::string content = "{\"result\": \"success\"}";
    
    Message message = ApplyModule::createToolMessage(toolCallId, content);
    
    EXPECT_EQ(message.role(), MessageRole::Tool);
    EXPECT_EQ(message.content(), content);
    EXPECT_EQ(message.toolCallId(), toolCallId);
}

// Integration Tests
TEST(ApplyModuleTest, FindAndModifyMessage) {
    std::vector<Message> messages;
    messages.push_back(Message::createUser("Hello"));
    messages.push_back(Message::createAssistant("Hi"));
    
    MessageId targetId = messages[1].id();
    Message* found = ApplyModule::findMessageById(messages, targetId);
    
    EXPECT_NE(found, nullptr);
    
    // Modify the found message
    found->appendContent(" there!");
    
    EXPECT_EQ(messages[1].content(), "Hi there!");
}

TEST(ApplyModuleTest, FindAndModifyToolCall) {
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

TEST(ApplyModuleTest, MultipleMessageOperations) {
    std::vector<Message> messages;
    
    // Add user message
    messages.push_back(Message::createUser("Question"));
    
    // Add assistant message with custom ID
    MessageId assistantId = "assistant-1";
    messages.push_back(ApplyModule::createAssistantMessage(assistantId));
    
    // Find and modify assistant message
    Message* assistant = ApplyModule::findMessageById(messages, assistantId);
    EXPECT_NE(assistant, nullptr);
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
    EXPECT_NE(lastAssistant, nullptr);
    EXPECT_EQ(lastAssistant->id(), assistantId);
}

TEST(ApplyModuleTest, ValidateComplexState) {
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
