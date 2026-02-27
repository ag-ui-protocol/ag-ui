#pragma once

#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "core/error.h"

namespace agui {

enum class PatchOperation { Add, Remove, Replace, Move, Copy, Test };

struct JsonPatchOp {
    PatchOperation op;
    std::string path;
    nlohmann::json value;
    std::string from;

    JsonPatchOp() : op(PatchOperation::Add) {}

    nlohmann::json toJson() const;
    static JsonPatchOp fromJson(const nlohmann::json& j);
};

class StateManager {
public:
    StateManager();
    explicit StateManager(const nlohmann::json& initialState);

    const nlohmann::json& currentState() const { return m_currentState; }
    void setState(const nlohmann::json& state);
    void applyPatch(const nlohmann::json& patch);
    void applyPatchOp(const JsonPatchOp& op);
    bool validateState(const nlohmann::json* schema = nullptr) const;
    nlohmann::json createSnapshot() const;
    void restoreFromSnapshot(const nlohmann::json& snapshot);
    void clear();
    size_t historySize() const { return m_history.size(); }
    void enableHistory(bool enable, size_t maxSize = 10);
    bool rollback();
    const nlohmann::json* getHistory(size_t index) const;

private:
    nlohmann::json m_currentState;
    std::vector<nlohmann::json> m_history;
    bool m_historyEnabled;
    size_t m_maxHistorySize;

    void addToHistory(const nlohmann::json& state);
    void applyAdd(const std::string& path, const nlohmann::json& value);
    void applyRemove(const std::string& path);
    void applyReplace(const std::string& path, const nlohmann::json& value);
    void applyMove(const std::string& from, const std::string& path);
    void applyCopy(const std::string& from, const std::string& path);
    void applyTest(const std::string& path, const nlohmann::json& value);
    static std::vector<std::string> parsePath(const std::string& path);
    nlohmann::json* getValueAtPath(const std::string& path);
    const nlohmann::json* getValueAtPath(const std::string& path) const;
    void setValueAtPath(const std::string& path, const nlohmann::json& value, bool createPath = true);
    void removeValueAtPath(const std::string& path);
};

class StateSnapshot {
public:
    StateSnapshot() = default;
    explicit StateSnapshot(const nlohmann::json& state);

    const nlohmann::json& state() const { return m_state; }

    nlohmann::json toJson() const;
    static StateSnapshot fromJson(const nlohmann::json& j);

private:
    nlohmann::json m_state;
    std::chrono::system_clock::time_point m_timestamp;
};

}  // namespace agui
