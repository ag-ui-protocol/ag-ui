#pragma once

#include <map>
#include <memory>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

#include "core/error.h"
#include "core/event.h"
#include "core/session_types.h"
#include "core/subscriber.h"

namespace agui {

/**
 * @brief Apply module - Core event processing utilities
 * 
 * Provides helper functions for event processing and state management.
 * Works with EventHandler class for complete event processing pipeline.
 */
class ApplyModule {
public:
    // Helper functions for message management
    static Message* findMessageById(std::vector<Message>& messages, const MessageId& id);
    static const Message* findMessageById(const std::vector<Message>& messages, const MessageId& id);
    static Message* findLastAssistantMessage(std::vector<Message>& messages);
    
    // Helper functions for tool call management
    static const ToolCall* findToolCallById(const Message& message, const ToolCallId& id);
    
    // State management helpers
    static void applyJsonPatch(nlohmann::json& state, const nlohmann::json& patch);
    static bool validateState(const nlohmann::json& state);
    
    // Message creation helpers
    static Message createAssistantMessage(const MessageId& id);
    static Message createToolMessage(const ToolCallId& toolCallId, const std::string& content);
};

}  // namespace agui
