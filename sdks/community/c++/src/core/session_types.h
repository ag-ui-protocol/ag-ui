#pragma once

#include <map>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

namespace agui {

// Type aliases
using AgentId = std::string;
using ThreadId = std::string;
using RunId = std::string;
using MessageId = std::string;
using ToolCallId = std::string;

// Forward declarations
class Message;
class Tool;
class Context;
class ToolCall;

/**
 * @brief Message role enumeration
 */
enum class MessageRole { User, Assistant, System, Tool };

/**
 * @brief Function call information
 */
struct FunctionCall {
    std::string name;
    std::string arguments;

    FunctionCall() = default;
    FunctionCall(const std::string& n, const std::string& args) : name(n), arguments(args) {}
};

/**
 * @brief Tool call information
 */
class ToolCall {
public:
    ToolCallId id;
    std::string callType;
    FunctionCall function;

    ToolCall() : callType("function") {}

    nlohmann::json toJson() const;
    static ToolCall fromJson(const nlohmann::json& j);
};

/**
 * @brief Message class
 */
class Message {
public:
    Message();
    Message(const MessageId &mid, const MessageRole &role, const std::string &content);
    ~Message();

    static Message createUser(const std::string& content, const std::string& name = "");
    static Message createAssistant(const std::string& content, const std::string& name = "");
    static Message createSystem(const std::string& content);
    static Message createTool(const std::string& toolCallId, const std::string& content);

    const MessageId& id() const { return _id; }
    MessageRole role() const { return _role; }
    const std::string& content() const { return _content; }
    const std::string& name() const { return _name; }
    const std::vector<ToolCall>& toolCalls() const { return _toolCalls; }

    void setRole(const MessageRole &role) {_role = role;}
    void setContent(const std::string& content) { _content = content; }
    void appendContent(const std::string& delta) { _content += delta; }
    void addToolCall(const ToolCall& toolCall) { _toolCalls.push_back(toolCall); }

    nlohmann::json toJson() const;
    static Message fromJson(const nlohmann::json& j);

private:
    MessageId _id;
    MessageRole _role;
    std::string _content;
    std::string _name;
    std::vector<ToolCall> _toolCalls;
    std::string _toolCallId;
};

/**
 * @brief Tool definition
 */
class Tool {
public:
    std::string name;
    std::string description;
    nlohmann::json parameters;

    nlohmann::json toJson() const;
    static Tool fromJson(const nlohmann::json& j);
};

/**
 * @brief Context information
 */
class Context {
public:
    std::string type;
    std::string data;

    nlohmann::json toJson() const;
    static Context fromJson(const nlohmann::json& j);
};

/**
 * @brief Agent execution input parameters
 */
class RunAgentInput {
public:
    ThreadId threadId;
    RunId runId;
    std::string state;
    std::vector<Message> messages;
    std::vector<Tool> tools;
    std::vector<Context> context;
    std::string forwardedProps;

    nlohmann::json toJson() const;
    static RunAgentInput fromJson(const nlohmann::json& j);
};

/**
 * @brief Agent execution result
 */
class RunAgentResult {
public:
    ThreadId threadId;
    std::string result;
    std::vector<Message> newMessages;
    std::string newState;

    RunAgentResult() = default;
};

// Forward declarations
class IAgentSubscriber;

/**
 * @brief Agent execution parameters
 */
class RunAgentParams {
public:
    RunAgentParams() = default;

    ThreadId threadId;
    RunId runId;
    std::vector<Tool> tools;
    std::vector<Context> context;
    std::string forwardedProps;
    std::vector<Message> messages;
    std::string state;
    std::vector<std::shared_ptr<IAgentSubscriber>> subscribers;

    RunAgentParams& withRunId(const RunId& id);
    RunAgentParams& addTool(const Tool& tool);
    RunAgentParams& addContext(const Context& ctx);
    RunAgentParams& withForwardedProps(const nlohmann::json& props);
    RunAgentParams& withState(const nlohmann::json& s);
    RunAgentParams& addMessage(const Message& msg);
    RunAgentParams& addUserMessage(const std::string& content);
    RunAgentParams& addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber);
};

}  // namespace agui
