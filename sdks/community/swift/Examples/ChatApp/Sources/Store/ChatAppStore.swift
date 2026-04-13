/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import AGUIAgentSDK
import AGUICore
import Foundation

// MARK: - ChatAppStore

/// Central store that drives the entire chat UI.
///
/// All `@Published` mutations run on the main actor. The streaming
/// `Task` suspends the main actor only during network waits, so UI
/// updates remain snappy.
///
/// Event processing logic lives in `ChatAppStore+EventProcessing.swift`.
@MainActor
final class ChatAppStore: ObservableObject {

    // MARK: - Published state

    @Published var state: ChatUIState = .init()
    @Published private(set) var agents: [AgentConfig] = []
    @Published var formMode: AgentFormMode?
    @Published var draft: AgentDraft = .init()
    @Published var repositoryError: String?

    // MARK: - Private state

    private var agent: StatefulAgUiAgent?
    private var streamingTask: Task<Void, Never>?
    /// messageId → index in `state.messages` for O(1) delta updates.
    var streamingMessageIndices: [String: Int] = [:]
    /// Per-slot dismiss tasks; keyed so TOOL_CALL and STEP cancel independently.
    var ephemeralDismissTasks: [EphemeralSlot: Task<Void, Never>] = [:]
    /// The `id` of the optimistic user message currently awaiting agent confirmation.
    var pendingUserMessageId: String?
    /// Buffered tool-call arguments keyed by toolCallId.
    ///
    /// Populated on `ToolCallStartEvent`, appended on `ToolCallArgsEvent`,
    /// removed on `ToolCallEndEvent`. Marked `internal` for test inspection.
    var toolCallArgBuffer: [String: String] = [:]
    /// Phase 4: Manages raw JSON state for each A2UI surface.
    let surfaceManager = A2UISurfaceStateManager()

    // MARK: - Persistence

    private let defaults: UserDefaults
    private static let agentsKey = "chatapp.agents"
    private static let activeAgentIdKey = "chatapp.activeAgentId"

    var selectedAgentId: String? { state.activeAgent?.id }

    // MARK: - Init

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        agents = Self.loadAgents(from: defaults)
        if let id = defaults.string(forKey: Self.activeAgentIdKey),
           let config = agents.first(where: { $0.id == id }) {
            buildAgent(from: config)
        }
    }

    // MARK: - Chat actions

    func sendMessage(_ text: String) {
        guard let agent else { return }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Cancel any in-flight stream and clean up ephemeral state.
        cancelStreaming()
        streamingMessageIndices.removeAll()

        // Phase 1C: Optimistic user message — shown immediately before agent ack.
        let messageId = UUID().uuidString
        let userMsg = DisplayMessage(
            id: messageId,
            role: .user,
            content: trimmed,
            timestamp: .now,
            isSending: true
        )
        state.messages.append(userMsg)
        pendingUserMessageId = messageId
        state.isLoading = true

        streamingTask = Task { [weak self] in
            guard let self else { return }
            defer {
                self.state.isLoading = false
                // Clear all ephemeral banners and their scheduled dismissals.
                self.state.ephemeralSlots.removeAll()
                for task in self.ephemeralDismissTasks.values { task.cancel() }
                self.ephemeralDismissTasks.removeAll()
                self.finishStreamingMessages()
            }
            do {
                let stream = try await agent.chat(message: trimmed)
                for try await event in stream {
                    self.processEvent(event)
                }
            } catch is CancellationError {
                // User cancelled — remove the optimistic message and show no error.
                if let pendingId = self.pendingUserMessageId {
                    self.state.messages.removeAll { $0.id == pendingId }
                    self.pendingUserMessageId = nil
                }
            } catch {
                // On error: keep the optimistic message but mark it as no longer sending.
                if let pendingId = self.pendingUserMessageId,
                   let idx = self.state.messages.firstIndex(where: { $0.id == pendingId }) {
                    self.state.messages[idx].isSending = false
                    self.pendingUserMessageId = nil
                }
                self.state.error = error.localizedDescription
            }
        }
    }

    func cancelStreaming() {
        streamingTask?.cancel()
        streamingTask = nil
        // Cancel any pending ephemeral dismissal timers.
        for task in ephemeralDismissTasks.values { task.cancel() }
        ephemeralDismissTasks.removeAll()
        state.ephemeralSlots.removeAll()
        toolCallArgBuffer.removeAll()
        // Clear the optimistic pending message.
        if let pendingId = pendingUserMessageId {
            state.messages.removeAll { $0.id == pendingId }
            pendingUserMessageId = nil
        }
    }

    func dismissError() {
        state.error = nil
    }

    // MARK: - Agent management

    func setActiveAgent(id: String?) {
        guard id != state.activeAgent?.id else { return }
        cancelStreaming()
        streamingMessageIndices.removeAll()
        toolCallArgBuffer.removeAll()
        surfaceManager.reset()

        if let id, let config = agents.first(where: { $0.id == id }) {
            buildAgent(from: config)
        } else {
            agent = nil
            state = ChatUIState()
        }
        saveActiveAgentId(id)
    }

    func presentCreateAgent() {
        draft = AgentDraft()
        formMode = .create
    }

    func presentEditAgent(_ config: AgentConfig) {
        draft = AgentDraft(from: config)
        formMode = .edit(config)
    }

    func dismissAgentForm() {
        formMode = nil
    }

    func saveAgent() {
        guard let mode = formMode, draft.isValid else { return }

        switch mode {
        case .create:
            let config = draft.toAgentConfig()
            agents.append(config)
            persistAgents()
            formMode = nil
            setActiveAgent(id: config.id)

        case .edit(let existing):
            let config = draft.toAgentConfig(existingId: existing.id)
            if let idx = agents.firstIndex(where: { $0.id == existing.id }) {
                agents[idx] = config
                persistAgents()
            }
            formMode = nil
            if config.id == state.activeAgent?.id {
                buildAgent(from: config)
            }
        }
    }

    func deleteAgent(id: String) {
        agents.removeAll { $0.id == id }
        persistAgents()

        if state.activeAgent?.id == id {
            cancelStreaming()
            if let next = agents.first {
                buildAgent(from: next)
                saveActiveAgentId(next.id)
            } else {
                agent = nil
                state = ChatUIState()
                saveActiveAgentId(nil)
            }
        }
    }

    // MARK: - Testing support

    /// Resets state and configures an active agent for unit tests.
    func setupForTesting(agent config: AgentConfig) {
        state = ChatUIState(isConnected: true, activeAgent: config)
        streamingMessageIndices = [:]
        ephemeralDismissTasks.removeAll()
        toolCallArgBuffer.removeAll()
        pendingUserMessageId = nil
        surfaceManager.reset()
    }

    /// Injects an optimistic user message for unit tests without going through `sendMessage`.
    func injectPendingMessageForTesting(content: String) {
        let id = UUID().uuidString
        let msg = DisplayMessage(id: id, role: .user, content: content, isSending: true)
        state.messages.append(msg)
        pendingUserMessageId = id
    }

    // MARK: - Private helpers

    private func buildAgent(from config: AgentConfig) {
        do {
            let baseConfig = try config.toStatefulAgentConfig()
            // Create the agent immediately (no tool registry yet) so the UI is usable right away.
            agent = StatefulAgUiAgent(configuration: baseConfig)
            state = ChatUIState(isConnected: true, activeAgent: config)
            // Phase 1B: Record the connection as an in-chat supplemental message.
            appendSupplemental(SupplementalMessage(
                id: UUID().uuidString,
                kind: .connection(agentName: config.name),
                timestamp: .now
            ))

            // Phase 2B: Asynchronously enhance the agent with client-side tool executors.
            // The agent remains functional during setup; tools are added once ready.
            Task { [weak self] in
                guard let self else { return }
                do {
                    let registry = try await ChatAppToolRegistry.makeRegistry { [weak self] hex in
                        await MainActor.run { self?.state.backgroundHex = hex }
                    }
                    var configWithTools = baseConfig
                    configWithTools.toolRegistry = registry
                    self.agent = StatefulAgUiAgent(configuration: configWithTools)
                } catch {
                    // Tool registry setup failed — agent continues without client-side tools.
                }
            }
        } catch {
            state.error = error.localizedDescription
        }
    }

    func finishStreamingMessages() {
        for idx in state.messages.indices where state.messages[idx].isStreaming {
            state.messages[idx].isStreaming = false
        }
        streamingMessageIndices.removeAll()
        toolCallArgBuffer.removeAll()
    }

    // MARK: - Persistence helpers

    private static func loadAgents(from defaults: UserDefaults) -> [AgentConfig] {
        guard
            let data = defaults.data(forKey: agentsKey),
            let decoded = try? JSONDecoder().decode([AgentConfig].self, from: data)
        else { return [] }
        return decoded
    }

    private func persistAgents() {
        if let encoded = try? JSONEncoder().encode(agents) {
            defaults.set(encoded, forKey: Self.agentsKey)
        }
    }

    private func saveActiveAgentId(_ id: String?) {
        defaults.set(id, forKey: Self.activeAgentIdKey)
    }
}
