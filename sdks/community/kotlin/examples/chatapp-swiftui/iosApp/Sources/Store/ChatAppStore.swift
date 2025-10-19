import Foundation
import Combine
import SwiftUI
import shared

final class ChatAppStore: ObservableObject {
    @Published private(set) var chatState: ChatStateSnapshot
    @Published private(set) var agents: [AgentSnapshot]
    @Published var selectedAgentId: String?
    @Published var formMode: AgentFormMode?
    @Published var draft: AgentDraft = AgentDraft()
    @Published var isPerformingAgentMutation = false
    @Published var repositoryError: String?

    private let chatBridge: ChatViewModelBridge
    private let repositoryBridge: AgentRepositoryBridge

    private var chatSubscription: FlowSubscription?
    private var agentsSubscription: FlowSubscription?
    private var activeAgentSubscription: FlowSubscription?

    init(chatBridge: ChatViewModelBridge = ChatViewModelBridge(),
         repositoryBridge: AgentRepositoryBridge = AgentRepositoryBridge()) {
        self.chatBridge = chatBridge
        self.repositoryBridge = repositoryBridge
        self.chatState = chatBridge.currentState()
        self.agents = repositoryBridge.currentAgents()
        self.selectedAgentId = repositoryBridge.currentActiveAgent()?.id ?? chatState.activeAgent?.id
        subscribe()
    }

    deinit {
        chatSubscription?.cancel()
        agentsSubscription?.cancel()
        activeAgentSubscription?.cancel()
        chatBridge.close()
        repositoryBridge.close()
    }

    private func subscribe() {
        chatSubscription = chatBridge.observeState { [weak self] snapshot in
            guard let self else { return }
            self.chatState = snapshot
            if let activeId = snapshot.activeAgent?.id {
                self.selectedAgentId = activeId
            }
        }

        agentsSubscription = repositoryBridge.observeAgents { [weak self] agents in
            self?.agents = agents
        }

        activeAgentSubscription = repositoryBridge.observeActiveAgent { [weak self] agent in
            self?.selectedAgentId = agent?.id
        }
    }

    // MARK: - Chat actions

    func sendMessage(_ text: String) {
        chatBridge.sendMessage(content: text)
    }

    func cancelStreaming() {
        chatBridge.cancelCurrentOperation()
    }

    func dismissError() {
        chatBridge.clearError()
    }

    // MARK: - Agent management

    func setActiveAgent(id: String?) {
        selectedAgentId = id
        repositoryBridge.setActiveAgent(agentId: id) { [weak self] error in
            guard let self, let error else { return }
            self.repositoryError = error.message ?? "Unknown error"
        }
    }

    func presentCreateAgent() {
        draft = AgentDraft()
        formMode = .create
    }

    func presentEditAgent(agent: AgentSnapshot) {
        draft = AgentDraft(snapshot: agent)
        formMode = .edit(agent)
    }

    func dismissAgentForm() {
        formMode = nil
    }

    func saveAgent() {
        guard let mode = formMode else { return }

        let headers = draft.headers.compactMap { $0.toHeaderEntry() }
        let authSnapshot = draft.toAuthMethod()
        let systemPrompt = draft.systemPrompt.isEmpty ? nil : draft.systemPrompt
        let description = draft.description.isEmpty ? nil : draft.description

        isPerformingAgentMutation = true

        switch mode {
        case .create:
            let config = ChatBridgeFactory.shared.createAgentConfig(
                name: draft.name,
                url: draft.url,
                description: description,
                authMethod: authSnapshot,
                headers: headers,
                systemPrompt: systemPrompt
            )

            repositoryBridge.addAgent(agent: config) { [weak self] error in
                guard let self else { return }
                self.isPerformingAgentMutation = false
                if let error {
                    self.repositoryError = error.message ?? "Unknown error"
                } else {
                    self.formMode = nil
                    self.setActiveAgent(id: config.id)
                }
            }
        case .edit(let existing):
            let config = ChatBridgeFactory.shared.updateAgentConfig(
                existing: existing,
                name: draft.name,
                url: draft.url,
                description: description,
                authMethod: authSnapshot,
                headers: headers,
                systemPrompt: systemPrompt
            )

            repositoryBridge.updateAgent(agent: config) { [weak self] error in
                guard let self else { return }
                self.isPerformingAgentMutation = false
                if let error {
                    self.repositoryError = error.message ?? "Unknown error"
                } else {
                    self.formMode = nil
                }
            }
        }
    }

    func deleteAgent(id: String) {
        repositoryBridge.deleteAgent(agentId: id) { [weak self] error in
            guard let self, let error else { return }
            self.repositoryError = error.message ?? "Unknown error"
        }
    }
}

// MARK: - Agent form support

enum AgentFormMode: Equatable {
    case create
    case edit(AgentSnapshot)

    static func == (lhs: AgentFormMode, rhs: AgentFormMode) -> Bool {
        switch (lhs, rhs) {
        case (.create, .create): return true
        case let (.edit(l), .edit(r)): return l.id == r.id
        default: return false
        }
    }
}

struct AgentDraft {
    var name: String = ""
    var url: String = ""
    var description: String = ""
    var systemPrompt: String = ""
    var headers: [HeaderField] = []
    var authSelection: AuthMethodSelection = .none

    // Auth specific fields
    var apiKey: String = ""
    var apiHeaderName: String = "X-API-Key"
    var bearerToken: String = ""
    var basicUsername: String = ""
    var basicPassword: String = ""
    var oauthClientId: String = ""
    var oauthClientSecret: String = ""
    var oauthAuthorizationURL: String = ""
    var oauthTokenURL: String = ""
    var oauthScopes: String = ""
    var oauthAccessToken: String = ""
    var oauthRefreshToken: String = ""
    var customType: String = ""
    var customConfiguration: [HeaderField] = []

    init() {}

    init(snapshot: AgentSnapshot) {
        name = snapshot.name
        url = snapshot.url
        description = snapshot.description_ ?? ""
        systemPrompt = snapshot.systemPrompt ?? ""
        headers = snapshot.customHeaders.map { HeaderField(key: $0.key, value: $0.value) }
        authSelection = AuthMethodSelection(kindIdentifier: snapshot.authMethod.kind)

        switch authSelection {
        case .apiKey:
            apiKey = snapshot.authMethod.key ?? ""
            apiHeaderName = snapshot.authMethod.headerName ?? "X-API-Key"
        case .bearerToken:
            bearerToken = snapshot.authMethod.token ?? ""
        case .basicAuth:
            basicUsername = snapshot.authMethod.username ?? ""
            basicPassword = snapshot.authMethod.password ?? ""
        case .oauth2:
            oauthClientId = snapshot.authMethod.clientId ?? ""
            oauthClientSecret = snapshot.authMethod.clientSecret ?? ""
            oauthAuthorizationURL = snapshot.authMethod.authorizationUrl ?? ""
            oauthTokenURL = snapshot.authMethod.tokenUrl ?? ""
            oauthScopes = snapshot.authMethod.scopes.joined(separator: ", ")
            oauthAccessToken = snapshot.authMethod.accessToken ?? ""
            oauthRefreshToken = snapshot.authMethod.refreshToken ?? ""
        case .custom:
            customType = snapshot.authMethod.customType ?? ""
            customConfiguration = snapshot.authMethod.customConfiguration.map { HeaderField(key: $0.key, value: $0.value) }
        case .none:
            break
        }
    }

    func toAuthMethod() -> AuthMethodSnapshot {
        switch authSelection {
        case .none:
            return makeSnapshot(kind: .none)
        case .apiKey:
            return makeSnapshot(kind: .apiKey, key: apiKey, headerName: apiHeaderName)
        case .bearerToken:
            return makeSnapshot(kind: .bearerToken, token: bearerToken)
        case .basicAuth:
            return makeSnapshot(kind: .basicAuth, username: basicUsername, password: basicPassword)
        case .oauth2:
            let scopes = oauthScopes
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            return ChatBridgeFactory.shared.createOAuth2Auth(
                clientId: oauthClientId,
                clientSecret: oauthClientSecret.isEmpty ? nil : oauthClientSecret,
                authorizationUrl: oauthAuthorizationURL,
                tokenUrl: oauthTokenURL,
                scopes: scopes,
                accessToken: oauthAccessToken.isEmpty ? nil : oauthAccessToken,
                refreshToken: oauthRefreshToken.isEmpty ? nil : oauthRefreshToken
            )
        case .custom:
            let entries = customConfiguration.compactMap { $0.toHeaderEntry() }
            return ChatBridgeFactory.shared.createCustomAuth(type: customType, entries: entries)
        }
    }

    private func makeSnapshot(
        kind: AuthMethodSelection,
        key: String? = nil,
        headerName: String? = nil,
        token: String? = nil,
        username: String? = nil,
        password: String? = nil,
        clientId: String? = nil,
        clientSecret: String? = nil,
        authorizationUrl: String? = nil,
        tokenUrl: String? = nil,
        scopes: [String] = [],
        accessToken: String? = nil,
        refreshToken: String? = nil,
        customType: String? = nil,
        customConfiguration: [HeaderEntry] = []
    ) -> AuthMethodSnapshot {
        AuthMethodSnapshot(
            kind: kind.rawValue,
            key: key,
            headerName: headerName,
            token: token,
            username: username,
            password: password,
            clientId: clientId,
            clientSecret: clientSecret,
            authorizationUrl: authorizationUrl,
            tokenUrl: tokenUrl,
            scopes: scopes,
            accessToken: accessToken,
            refreshToken: refreshToken,
            customType: customType,
            customConfiguration: customConfiguration
        )
    }
}

enum AuthMethodSelection: String, CaseIterable, Identifiable {
    case none
    case apiKey
    case bearerToken
    case basicAuth
    case oauth2
    case custom

    init(kindIdentifier: String) {
        self = AuthMethodSelection(rawValue: kindIdentifier) ?? .none
    }

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: return "None"
        case .apiKey: return "API Key"
        case .bearerToken: return "Bearer Token"
        case .basicAuth: return "Basic Auth"
        case .oauth2: return "OAuth 2.0"
        case .custom: return "Custom"
        }
    }
}

struct HeaderField: Identifiable, Hashable {
    let id: UUID = UUID()
    var key: String
    var value: String

    func toHeaderEntry() -> HeaderEntry? {
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedValue = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty, !trimmedValue.isEmpty else { return nil }
        return HeaderEntry(key: trimmedKey, value: trimmedValue)
    }
}
