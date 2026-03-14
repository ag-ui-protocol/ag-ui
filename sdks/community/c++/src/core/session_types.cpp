#include "session_types.h"

#include "uuid.h"

namespace agui {

// ToolCall implementation

nlohmann::json ToolCall::toJson() const {
    nlohmann::json j;
    j["id"] = id;
    j["type"] = callType;
    j["function"] = {{"name", function.name}, {"arguments", function.arguments}};
    return j;
}

ToolCall ToolCall::fromJson(const nlohmann::json& j) {
    ToolCall tc;
    tc.id = j.value("id", "");
    tc.callType = j.value("type", "function");

    if (j.contains("function")) {
        const auto& func = j["function"];
        tc.function.name = func.value("name", "");
        tc.function.arguments = func.value("arguments", "");
    }

    return tc;
}

// Message implementation

Message::Message() : _id(UuidGenerator::generate()), _role(MessageRole::User) {}

Message::Message(const MessageId &mid, const MessageRole &role, const std::string &content) :
    _id(mid),
    _role(role),
    _content(content) {}

Message::~Message() {}

Message Message::createUser(const std::string& content, const std::string& name) {
    Message msg;
    msg._id = UuidGenerator::generate();
    msg._role = MessageRole::User;
    msg._content = content;
    msg._name = name;
    return msg;
}

Message Message::createAssistant(const std::string& content, const std::string& name) {
    Message msg;
    msg._id = UuidGenerator::generate();
    msg._role = MessageRole::Assistant;
    msg._content = content;
    msg._name = name;
    return msg;
}

Message Message::createSystem(const std::string& content) {
    Message msg;
    msg._id = UuidGenerator::generate();
    msg._role = MessageRole::System;
    msg._content = content;
    return msg;
}

Message Message::createTool(const std::string& toolCallId, const std::string& content) {
    Message msg;
    msg._id = UuidGenerator::generate();
    msg._role = MessageRole::Tool;
    msg._content = content;
    msg._toolCallId = toolCallId;
    return msg;
}

// Overloaded versions with custom ID
Message Message::createUserWithId(const MessageId& id, const std::string& content, const std::string& name) {
    Message msg;
    msg._id = id;  // Use provided ID instead of generating
    msg._role = MessageRole::User;
    msg._content = content;
    msg._name = name;
    return msg;
}

Message Message::createAssistantWithId(const MessageId& id, const std::string& content, const std::string& name) {
    Message msg;
    msg._id = id;  // Use provided ID instead of generating
    msg._role = MessageRole::Assistant;
    msg._content = content;
    msg._name = name;
    return msg;
}

Message Message::createSystemWithId(const MessageId& id, const std::string& content) {
    Message msg;
    msg._id = id;  // Use provided ID instead of generating
    msg._role = MessageRole::System;
    msg._content = content;
    return msg;
}

Message Message::createToolWithId(const MessageId& id, const std::string& toolCallId, const std::string& content) {
    Message msg;
    msg._id = id;  // Use provided ID instead of generating
    msg._role = MessageRole::Tool;
    msg._content = content;
    msg._toolCallId = toolCallId;
    return msg;
}

nlohmann::json Message::toJson() const {
    nlohmann::json j;
    j["id"] = _id;

    // Role
    switch (_role) {
        case MessageRole::User:
            j["role"] = "user";
            break;
        case MessageRole::Assistant:
            j["role"] = "assistant";
            break;
        case MessageRole::System:
            j["role"] = "system";
            break;
        case MessageRole::Tool:
            j["role"] = "tool";
            break;
    }

    // Content
    if (!_content.empty()) {
        j["content"] = _content;
    }

    // Name
    if (!_name.empty()) {
        j["name"] = _name;
    }

    // Tool calls
    if (!_toolCalls.empty()) {
        nlohmann::json toolCallsJson = nlohmann::json::array();
        for (const auto& tc : _toolCalls) {
            toolCallsJson.push_back(tc.toJson());
        }
        j["toolCalls"] = toolCallsJson;
    }

    // toolCallId for Tool role
    if (_role == MessageRole::Tool && !_toolCallId.empty()) {
        j["toolCallId"] = _toolCallId;
    }

    return j;
}

Message Message::fromJson(const nlohmann::json& j) {
    Message msg;

    msg._id = j.value("id", UuidGenerator::generate());

    // Parse role
    std::string roleStr = j.value("role", "user");
    if (roleStr == "user") {
        msg._role = MessageRole::User;
    } else if (roleStr == "assistant") {
        msg._role = MessageRole::Assistant;
    } else if (roleStr == "system") {
        msg._role = MessageRole::System;
    } else if (roleStr == "tool") {
        msg._role = MessageRole::Tool;
    }

    msg._content = j.value("content", "");
    msg._name = j.value("name", "");
    msg._toolCallId = j.value("toolCallId", "");

    // Parse tool calls
    if (j.contains("toolCalls") && j["toolCalls"].is_array()) {
        for (const auto& tcJson : j["toolCalls"]) {
            msg._toolCalls.push_back(ToolCall::fromJson(tcJson));
        }
    }

    return msg;
}

void Message::assignEventDelta(const ToolCallId& toolCallId, const std::string &value) {
    for (auto &toolCall : _toolCalls) {
        if (toolCall.id == toolCallId) {
            toolCall.function.arguments = value;
        }
    }
}

void Message::appendEventDelta(const ToolCallId& toolCallId, const std::string &delta) {
    for (auto &toolCall : _toolCalls) {
        if (toolCall.id == toolCallId) {
            toolCall.function.arguments += delta;
        }
    }
}

// Tool implementation

nlohmann::json Tool::toJson() const {
    nlohmann::json j;
    j["name"] = name;
    j["description"] = description;
    j["parameters"] = parameters;
    return j;
}

Tool Tool::fromJson(const nlohmann::json& j) {
    Tool tool;
    tool.name = j.value("name", "");
    tool.description = j.value("description", "");
    tool.parameters = j.value("parameters", nlohmann::json::object());
    return tool;
}

// Context implementation

nlohmann::json Context::toJson() const {
    nlohmann::json j;
    j["type"] = type;
    j["data"] = data;
    return j;
}

Context Context::fromJson(const nlohmann::json& j) {
    Context ctx;
    ctx.type = j.value("type", "");
    ctx.data = j.value("data", "");
    return ctx;
}

// RunAgentInput implementation

nlohmann::json RunAgentInput::toJson() const {
    nlohmann::json j;
    j["threadId"] = threadId;
    j["runId"] = runId;
    j["state"] = state;
    j["forwardedProps"] = forwardedProps;

    // Messages array
    nlohmann::json messagesJson = nlohmann::json::array();
    for (const auto& msg : messages) {
        messagesJson.push_back(msg.toJson());
    }
    j["messages"] = messagesJson;

    // Tools array
    nlohmann::json toolsJson = nlohmann::json::array();
    for (const auto& tool : tools) {
        toolsJson.push_back(tool.toJson());
    }
    j["tools"] = toolsJson;

    // Context array
    nlohmann::json contextJson = nlohmann::json::array();
    for (const auto& ctx : context) {
        contextJson.push_back(ctx.toJson());
    }
    j["context"] = contextJson;

    return j;
}

RunAgentInput RunAgentInput::fromJson(const nlohmann::json& j) {
    RunAgentInput input;

    input.threadId = j.value("threadId", "");
    input.runId = j.value("runId", "");
    input.state = j.value("state", "");
    input.forwardedProps = j.value("forwardedProps", nlohmann::json::object());

    // Parse messages
    if (j.contains("messages") && j["messages"].is_array()) {
        for (const auto& msgJson : j["messages"]) {
            input.messages.push_back(Message::fromJson(msgJson));
        }
    }

    // Parse tools
    if (j.contains("tools") && j["tools"].is_array()) {
        for (const auto& toolJson : j["tools"]) {
            input.tools.push_back(Tool::fromJson(toolJson));
        }
    }

    // Parse context
    if (j.contains("context") && j["context"].is_array()) {
        for (const auto& ctxJson : j["context"]) {
            input.context.push_back(Context::fromJson(ctxJson));
        }
    }

    return input;
}

// RunAgentParams implementation

RunAgentParams& RunAgentParams::withRunId(const RunId& id) {
    runId = id;
    return *this;
}

RunAgentParams& RunAgentParams::addTool(const Tool& tool) {
    tools.push_back(tool);
    return *this;
}

RunAgentParams& RunAgentParams::addContext(const Context& ctx) {
    context.push_back(ctx);
    return *this;
}

RunAgentParams& RunAgentParams::withForwardedProps(const nlohmann::json& props) {
    forwardedProps = props;
    return *this;
}

RunAgentParams& RunAgentParams::withState(const nlohmann::json& s) {
    state = s.dump();
    return *this;
}

RunAgentParams& RunAgentParams::addMessage(const Message& msg) {
    messages.push_back(msg);
    return *this;
}

RunAgentParams& RunAgentParams::addUserMessage(const std::string& content) {
    messages.push_back(Message::createUser(content));
    return *this;
}

RunAgentParams& RunAgentParams::addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber) {
    subscribers.push_back(subscriber);
    return *this;
}

}  // namespace agui
