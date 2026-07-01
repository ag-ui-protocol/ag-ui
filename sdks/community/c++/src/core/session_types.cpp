#include "session_types.h"

#include "error.h"
#include "uuid.h"
#include "logger.h"

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
Message::Message(const MessageId &mid, const MessageRole &role, const std::string &content) :
    m_id(mid),
    m_role(role),
    m_content(content) {}

std::string Message::roleToString(MessageRole role) {
    switch (role) {
        case MessageRole::User:      return "user";
        case MessageRole::Assistant: return "assistant";
        case MessageRole::System:    return "system";
        case MessageRole::Tool:      return "tool";
        case MessageRole::Developer: return "developer";
        case MessageRole::Activity:  return "activity";
        case MessageRole::Reasoning: return "reasoning";
    }
    // A new MessageRole was added without a case here — throw rather than silently
    // returning "user" which would corrupt message history sent to the server.
    throw AGUI_ERROR(validation, ErrorCode::ValidationInvalidArgument,
                     "roleToString: unhandled MessageRole enumerator — update this switch");
}

MessageRole Message::roleFromString(const std::string& roleStr) {
    if (roleStr == "user")      return MessageRole::User;
    if (roleStr == "assistant") return MessageRole::Assistant;
    if (roleStr == "system")    return MessageRole::System;
    if (roleStr == "tool")      return MessageRole::Tool;
    if (roleStr == "developer") return MessageRole::Developer;
    if (roleStr == "activity")  return MessageRole::Activity;
    if (roleStr == "reasoning") return MessageRole::Reasoning;
    // Throw rather than defaulting to User — an unknown role would corrupt message
    // history sent back to the server on the next run.
    throw AGUI_ERROR(parse, ErrorCode::ParseEventError,
                     "Unknown message role: '" + roleStr + "'");
}

Message Message::create(MessageRole role, const std::string& content,
                         const std::string& name, const std::string& toolCallId) {
    Message msg;
    msg.m_id = UuidGenerator::generate();
    msg.m_role = role;
    msg.m_content = content;
    msg.m_name = name;
    msg.m_toolCallId = toolCallId;
    return msg;
}

Message Message::createWithId(const MessageId& id, MessageRole role,
                               const std::string& content, const std::string& name,
                               const std::string& toolCallId) {
    Message msg;
    msg.m_id = id;
    msg.m_role = role;
    msg.m_content = content;
    msg.m_name = name;
    msg.m_toolCallId = toolCallId;
    return msg;
}

nlohmann::json Message::toJson() const {
    nlohmann::json j;
    j["id"] = m_id;

    j["role"] = roleToString(m_role);

    if (!m_content.empty()) {
        j["content"] = m_content;
    }

    if (!m_name.empty()) {
        j["name"] = m_name;
    }

    if (!m_toolCalls.empty()) {
        nlohmann::json toolCallsJson = nlohmann::json::array();
        for (const auto& tc : m_toolCalls) {
            toolCallsJson.push_back(tc.toJson());
        }
        j["toolCalls"] = toolCallsJson;
    }

    if (m_role == MessageRole::Tool && !m_toolCallId.empty()) {
        j["toolCallId"] = m_toolCallId;
    }

    if (m_role == MessageRole::Activity && !m_activityType.empty()) {
        j["activityType"] = m_activityType;
    }

    return j;
}

Message Message::fromJson(const nlohmann::json& j) {
    Message msg;

    // If present, id must be a non-empty string; absent id gets a fresh UUID.
    if (j.contains("id")) {
        if (!j["id"].is_string() || j["id"].get<std::string>().empty()) {
            throw AGUI_ERROR(parse, ErrorCode::ParseMessageError,
                             "Message 'id' field must be a non-empty string");
        }
        msg.m_id = j["id"].get<std::string>();
    } else {
        msg.m_id = UuidGenerator::generate();
    }

    // role is required; defaulting to User would corrupt message history.
    if (!j.contains("role") || !j["role"].is_string()) {
        throw AGUI_ERROR(parse, ErrorCode::ParseMessageError,
                         "Message missing required 'role' field");
    }
    msg.m_role = roleFromString(j["role"].get<std::string>());

    msg.m_content = j.value("content", "");
    msg.m_name = j.value("name", "");
    msg.m_toolCallId = j.value("toolCallId", "");
    msg.m_activityType = j.value("activityType", "");

    if (j.contains("toolCalls") && j["toolCalls"].is_array()) {
        for (const auto& tcJson : j["toolCalls"]) {
            msg.m_toolCalls.push_back(ToolCall::fromJson(tcJson));
        }
    }

    return msg;
}

void Message::assignEventDelta(const ToolCallId& toolCallId, const std::string &value) {
    bool found = false;
    for (auto &toolCall : m_toolCalls) {
        if (toolCall.id == toolCallId) {
            toolCall.function.arguments = value;
            found = true;
            break;
        }
    }
    if (!found && !toolCallId.empty()) {
        Logger::warningf("assignEventDelta: toolCallId '", toolCallId,
                         "' not found in message ", m_id);
    }
}

void Message::appendEventDelta(const ToolCallId& toolCallId, const std::string &delta) {
    bool found = false;
    for (auto &toolCall : m_toolCalls) {
        if (toolCall.id == toolCallId) {
            toolCall.function.arguments += delta;
            found = true;
            break;
        }
    }
    if (!found && !toolCallId.empty()) {
        Logger::warningf("appendEventDelta: toolCallId '", toolCallId, 
                         "' not found in message ", m_id);
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
    j["description"] = description;
    j["value"] = value;
    return j;
}

Context Context::fromJson(const nlohmann::json& j) {
    Context ctx;
    ctx.description = j.value("description", "");
    ctx.value = j.value("value", "");
    return ctx;
}

// RunAgentInput implementation

nlohmann::json RunAgentInput::toJson() const {
    nlohmann::json j;
    j["threadId"] = threadId;
    j["runId"] = runId;
    if (parentRunId.has_value()) {
        j["parentRunId"] = parentRunId.value();
    }
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
    if (j.contains("parentRunId") && j["parentRunId"].is_string()) {
        input.parentRunId = j["parentRunId"].get<std::string>();
    }
    input.state = j.value("state", nlohmann::json::object());
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

RunAgentParams& RunAgentParams::withParentRunId(const RunId& id) {
    parentRunId = id;
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
    state = s;
    return *this;
}

RunAgentParams& RunAgentParams::addMessage(const Message& msg) {
    messages.push_back(msg);
    return *this;
}

RunAgentParams& RunAgentParams::addUserMessage(const std::string& content) {
    messages.push_back(Message::create(MessageRole::User, content));
    return *this;
}

RunAgentParams& RunAgentParams::addSubscriber(std::shared_ptr<IAgentSubscriber> subscriber) {
    subscribers.push_back(subscriber);
    return *this;
}

}  // namespace agui
