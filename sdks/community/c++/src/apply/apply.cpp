#include "apply.h"

namespace agui {

Message* ApplyModule::findMessageById(std::vector<Message>& messages, const MessageId& id) {
    for (auto& msg : messages) {
        if (msg.id() == id) {
            return &msg;
        }
    }
    return nullptr;
}

const Message* ApplyModule::findMessageById(const std::vector<Message>& messages, const MessageId& id) {
    for (const auto& msg : messages) {
        if (msg.id() == id) {
            return &msg;
        }
    }
    return nullptr;
}

Message* ApplyModule::findLastAssistantMessage(std::vector<Message>& messages) {
    for (auto it = messages.rbegin(); it != messages.rend(); ++it) {
        if (it->role() == MessageRole::Assistant) {
            return &(*it);
        }
    }
    return nullptr;
}

const ToolCall* ApplyModule::findToolCallById(const Message& message, const ToolCallId& id) {
    const auto& toolCalls = message.toolCalls();
    for (const auto& tc : toolCalls) {
        if (tc.id == id) {
            return &tc;
        }
    }
    return nullptr;
}

void ApplyModule::applyJsonPatch(nlohmann::json& state, const nlohmann::json& patch) {
    try {
        // Apply JSON Patch (RFC 6902)
        state = state.patch(patch);
    } catch (const std::exception& e) {
        std::cerr << "Failed to apply JSON patch: " << e.what() << std::endl;
        throw AgentError(ErrorType::State, ErrorCode::StatePatchFailed, 
                        "Failed to apply JSON patch: " + std::string(e.what()));
    }
}

bool ApplyModule::validateState(const nlohmann::json& stateObj) {
    // State must be a JSON object or null
    return stateObj.is_object() || stateObj.is_null();
}

Message ApplyModule::createAssistantMessage(const MessageId& id) {
    // Use the provided ID instead of generating a new one
    // This ensures TEXT_MESSAGE_START/CONTENT/END events share the same message ID
    return Message::createAssistantWithId(id, "");
}

Message ApplyModule::createToolMessage(const ToolCallId& toolCallId, const std::string& content) {
    return Message::createTool(toolCallId, content);
}

}  // namespace agui
