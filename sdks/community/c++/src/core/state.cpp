#include "core/state.h"

#include <algorithm>
#include <sstream>
#include "core/logger.h"

namespace agui {

namespace {

size_t parseArrayIndex(const std::string& segment, const std::string& path, bool allowAppendToken = false) {
    if (allowAppendToken && segment == "-") {
        return static_cast<size_t>(-1);
    }

    try {
        return std::stoul(segment);
    } catch (const std::invalid_argument&) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Invalid array index '" + segment + "' in path: " + path);
    } catch (const std::out_of_range&) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Array index out of range '" + segment + "' in path: " + path);
    }
}

}  // namespace

nlohmann::json JsonPatchOp::toJson() const {
    nlohmann::json j;

    switch (op) {
        case PatchOperation::Add:
            j["op"] = "add";
            break;
        case PatchOperation::Remove:
            j["op"] = "remove";
            break;
        case PatchOperation::Replace:
            j["op"] = "replace";
            break;
        case PatchOperation::Move:
            j["op"] = "move";
            break;
        case PatchOperation::Copy:
            j["op"] = "copy";
            break;
        case PatchOperation::Test:
            j["op"] = "test";
            break;
    }

    j["path"] = path;

    if (op != PatchOperation::Remove && op != PatchOperation::Move && op != PatchOperation::Copy) {
        j["value"] = value;
    }

    if (op == PatchOperation::Move || op == PatchOperation::Copy) {
        j["from"] = from;
    }

    return j;
}

JsonPatchOp JsonPatchOp::fromJson(const nlohmann::json& j) {
    JsonPatchOp patchOp;

    std::string opStr = j.at("op").get<std::string>();
    if (opStr == "add") {
        patchOp.op = PatchOperation::Add;
    } else if (opStr == "remove") {
        patchOp.op = PatchOperation::Remove;
    } else if (opStr == "replace") {
        patchOp.op = PatchOperation::Replace;
    } else if (opStr == "move") {
        patchOp.op = PatchOperation::Move;
    } else if (opStr == "copy") {
        patchOp.op = PatchOperation::Copy;
    } else if (opStr == "test") {
        patchOp.op = PatchOperation::Test;
    } else {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Unknown patch operation: " + opStr);
    }

    patchOp.path = j.at("path").get<std::string>();

    if (j.contains("value")) {
        patchOp.value = j["value"];
        patchOp.hasValue = true;
    }

    if (j.contains("from")) {
        patchOp.from = j["from"].get<std::string>();
    }

    return patchOp;
}

void JsonPatchOp::validate() const {
    // Validate path format (must start with /)
    if (path.empty() || path[0] != '/') {
        throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                         "Invalid JSON Pointer path: " + path);
    }

    // move and copy operations require from field
    if (op == PatchOperation::Move || op == PatchOperation::Copy) {
        const std::string opStr = (op == PatchOperation::Move) ? "move" : "copy";
        if (from.empty()) {
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                             "Operation '" + opStr + "' requires 'from' field");
        }
        if (from[0] != '/') {
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                             "Invalid JSON Pointer 'from' path: " + from);
        }
    }

    // add, replace, test operations require the "value" field to be present.
    // Two ways a value can be considered "provided":
    //   1. hasValue=true  — field was explicitly present in JSON (null is valid per RFC 6902)
    //   2. !value.is_null() — field was set directly on the struct without going through fromJson()
    // Only reject when both conditions indicate absence: hasValue=false AND value is null.
    if (op == PatchOperation::Add || op == PatchOperation::Replace || op == PatchOperation::Test) {
        if (!hasValue && value.is_null()) {
            std::string opStr;
            switch (op) {
                case PatchOperation::Add:     opStr = "add";     break;
                case PatchOperation::Replace: opStr = "replace"; break;
                case PatchOperation::Test:    opStr = "test";    break;
                default:                                         break;
            }
            throw AGUI_ERROR(validation, ErrorCode::ValidationError,
                             "Operation '" + opStr + "' requires 'value' field");
        }
    }
}

StateManager::StateManager()
    : m_currentState(nlohmann::json::object()), m_historyEnabled(false), m_maxHistorySize(10) {}

StateManager::StateManager(const nlohmann::json& initialState)
    : m_currentState(initialState), m_historyEnabled(false), m_maxHistorySize(10) {}

void StateManager::setState(const nlohmann::json& state) {
    if (m_historyEnabled) {
        addToHistory(m_currentState);
    }
    m_currentState = state;
}

void StateManager::applyPatch(const nlohmann::json& patch) {
    if (!patch.is_array()) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, 
                         "Patch must be an array");
    }

    nlohmann::json backup = m_currentState;

    try {
        for (const auto& opJson : patch) {
            JsonPatchOp op = JsonPatchOp::fromJson(opJson);
            applyPatchOp(op);
        }
    } catch (const AgentError& e) {
        Logger::errorf("StateManager::applyPatch failed: ", e.what());
        m_currentState = backup;
        throw;
    } catch (const nlohmann::json::exception& e) {
        Logger::errorf("StateManager::applyPatch JSON error: ", e.what());
        m_currentState = backup;
        throw AgentError(ErrorType::State, ErrorCode::StatePatchFailed, 
                         "JSON patch failed: " + std::string(e.what()));
    } catch (const std::exception& e) {
        Logger::errorf("StateManager::applyPatch error: ", e.what());
        m_currentState = backup;
        throw AgentError(ErrorType::State, ErrorCode::StatePatchFailed, 
                         "Patch operation failed: " + std::string(e.what()));
    }

    if (m_historyEnabled) {
        addToHistory(backup);
    }
}

void StateManager::applyPatchOp(const JsonPatchOp& op) {
    try {
        switch (op.op) {
            case PatchOperation::Add:
                applyAdd(op.path, op.value);
                break;
            case PatchOperation::Remove:
                applyRemove(op.path);
                break;
            case PatchOperation::Replace:
                applyReplace(op.path, op.value);
                break;
            case PatchOperation::Move:
                applyMove(op.from, op.path);
                break;
            case PatchOperation::Copy:
                applyCopy(op.from, op.path);
                break;
            case PatchOperation::Test:
                applyTest(op.path, op.value);
                break;
        }
    } catch (const AgentError&) {
        throw;
    } catch (const std::exception& e) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Patch operation failed: " + std::string(e.what()));
    }
}

bool StateManager::validateState() const {
    return !m_currentState.is_null();
}

nlohmann::json StateManager::createSnapshot() const {
    return m_currentState;
}

void StateManager::restoreFromSnapshot(const nlohmann::json& snapshot) {
    if (m_historyEnabled) {
        addToHistory(m_currentState);
    }
    m_currentState = snapshot;
}

void StateManager::clear() {
    if (m_historyEnabled) {
        addToHistory(m_currentState);
    }
    m_currentState = nlohmann::json::object();
}

void StateManager::enableHistory(bool enable, size_t maxSize) {
    m_historyEnabled = enable;
    m_maxHistorySize = maxSize;

    if (!enable) {
        m_history.clear();
    }
}

bool StateManager::rollback() {
    if (m_history.empty()) {
        return false;
    }

    m_currentState = m_history.back();
    m_history.pop_back();
    return true;
}

const nlohmann::json* StateManager::getHistory(size_t index) const {
    if (index >= m_history.size()) {
        return nullptr;
    }

    return &m_history[m_history.size() - 1 - index];
}

void StateManager::addToHistory(const nlohmann::json& state) {
    m_history.push_back(state);

    if (m_maxHistorySize > 0 && m_history.size() > m_maxHistorySize) {
        m_history.pop_front();
    }
}

void StateManager::applyAdd(const std::string& path, const nlohmann::json& value) {
    if (path.empty() || path == "/") {
        m_currentState = value;
        return;
    }

    std::vector<std::string> segments = parsePath(path);
    if (segments.empty()) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Invalid path: " + path);
    }

    nlohmann::json* current = &m_currentState;
    for (size_t i = 0; i < segments.size() - 1; ++i) {
        const std::string& segment = segments[i];

        if (current->is_object()) {
            if (!current->contains(segment)) {
                (*current)[segment] = nlohmann::json::object();
            }
            current = &(*current)[segment];
        } else if (current->is_array()) {
            size_t index = parseArrayIndex(segment, path);
            if (index >= current->size()) {
                throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                                 "Array index out of bounds: " + segment);
            }
            current = &(*current)[index];
        } else {
            throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                             "Cannot navigate through non-object/array: " + path);
        }
    }

    const std::string& lastSegment = segments.back();
    if (current->is_object()) {
        (*current)[lastSegment] = value;
    } else if (current->is_array()) {
        if (lastSegment == "-") {
            current->push_back(value);
        } else {
            size_t index = parseArrayIndex(lastSegment, path);
            if (index > current->size()) {
                throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                                 "Array index out of bounds: " + lastSegment);
            }
            current->insert(current->begin() + index, value);
        }
    } else {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Cannot add to non-object/array");
    }
}

void StateManager::applyRemove(const std::string& path) {
    if (path.empty() || path == "/") {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Cannot remove root");
    }

    std::vector<std::string> segments = parsePath(path);
    if (segments.empty()) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Invalid path: " + path);
    }

    nlohmann::json* current = &m_currentState;
    for (size_t i = 0; i < segments.size() - 1; ++i) {
        const std::string& segment = segments[i];

        if (current->is_object()) {
            if (!current->contains(segment)) {
                throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                                 "Path not found: " + path);
            }
            current = &(*current)[segment];
        } else if (current->is_array()) {
            size_t index = parseArrayIndex(segment, path);
            if (index >= current->size()) {
                throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                                 "Array index out of bounds: " + segment);
            }
            current = &(*current)[index];
        } else {
            throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                             "Cannot navigate through non-object/array: " + path);
        }
    }

    const std::string& lastSegment = segments.back();
    if (current->is_object()) {
        if (!current->contains(lastSegment)) {
            throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                             "Key not found: " + lastSegment);
        }
        current->erase(lastSegment);
    } else if (current->is_array()) {
        size_t index = parseArrayIndex(lastSegment, path);
        if (index >= current->size()) {
            throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                             "Array index out of bounds: " + lastSegment);
        }
        current->erase(current->begin() + index);
    } else {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Cannot remove from non-object/array");
    }
}

void StateManager::applyReplace(const std::string& path, const nlohmann::json& value) {
    if (path.empty() || path == "/") {
        m_currentState = value;
        return;
    }

    nlohmann::json* target = getValueAtPath(path);
    if (target == nullptr) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Path not found: " + path);
    }

    *target = value;
}

void StateManager::applyMove(const std::string& from, const std::string& path) {
    const nlohmann::json* sourceValue = getValueAtPath(from);
    if (sourceValue == nullptr) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Source path not found: " + from);
    }

    nlohmann::json valueCopy = *sourceValue;
    applyRemove(from);
    applyAdd(path, valueCopy);
}

void StateManager::applyCopy(const std::string& from, const std::string& path) {
    const nlohmann::json* sourceValue = getValueAtPath(from);
    if (sourceValue == nullptr) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Source path not found: " + from);
    }

    applyAdd(path, *sourceValue);
}

void StateManager::applyTest(const std::string& path, const nlohmann::json& value) {
    const nlohmann::json* target = getValueAtPath(path);
    if (target == nullptr) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument, "Path not found: " + path);
    }

    if (*target != value) {
        throw AgentError(ErrorType::Validation, ErrorCode::ValidationInvalidArgument,
                         "Test failed: value mismatch at " + path);
    }
}

std::vector<std::string> StateManager::parsePath(const std::string& path) {
    std::vector<std::string> segments;

    if (path.empty() || path[0] != '/') {
        return segments;
    }

    if (path == "/") {
        return segments;
    }

    std::string current;
    for (size_t i = 1; i < path.length(); ++i) {
        if (path[i] == '/') {
            segments.push_back(current);  // RFC 6901: always push token, even empty string
            current.clear();
        } else if (path[i] == '~') {
            if (i + 1 < path.length()) {
                if (path[i + 1] == '0') {
                    current += '~';
                    ++i;
                } else if (path[i + 1] == '1') {
                    current += '/';
                    ++i;
                } else {
                    current += path[i];
                }
            } else {
                current += path[i];
            }
        } else {
            current += path[i];
        }
    }

    segments.push_back(current);  // RFC 6901: always push final token, even empty string

    return segments;
}

nlohmann::json* StateManager::getValueAtPath(const std::string& path) {
    if (path.empty() || path == "/") {
        return &m_currentState;
    }

    std::vector<std::string> segments = parsePath(path);
    if (segments.empty()) {
        return nullptr;
    }

    nlohmann::json* current = &m_currentState;
    for (const std::string& segment : segments) {
        if (current->is_object()) {
            if (!current->contains(segment)) {
                return nullptr;
            }
            current = &(*current)[segment];
        } else if (current->is_array()) {
            // Let AgentError from parseArrayIndex propagate: callers must distinguish
            // "path not found" (nullptr) from "malformed path" (AgentError).
            size_t index = parseArrayIndex(segment, path);
            if (index >= current->size()) {
                return nullptr;
            }
            current = &(*current)[index];
        } else {
            return nullptr;
        }
    }

    return current;
}

void StateManager::removeValueAtPath(const std::string& path) {
    applyRemove(path);
}

StateSnapshot::StateSnapshot(const nlohmann::json& state)
    : m_state(state), m_timestamp(std::chrono::system_clock::now()) {}

nlohmann::json StateSnapshot::toJson() const {
    nlohmann::json j;
    j["state"] = m_state;

    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(m_timestamp.time_since_epoch()).count();
    j["timestamp"] = ms;

    return j;
}

StateSnapshot StateSnapshot::fromJson(const nlohmann::json& j) {
    StateSnapshot snapshot;

    if (j.contains("state")) {
        snapshot.m_state = j["state"];
    }

    if (j.contains("timestamp")) {
        if (!j["timestamp"].is_number()) {
            throw AGUI_ERROR(parse, ErrorCode::ParseJsonError,
                             "StateSnapshot 'timestamp' field must be a number (ms since epoch), got: " +
                             j["timestamp"].dump());
        }
        int64_t ms = j["timestamp"].get<int64_t>();
        snapshot.m_timestamp = std::chrono::system_clock::time_point(std::chrono::milliseconds(ms));
    }

    return snapshot;
}

}  // namespace agui
