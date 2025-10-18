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

    private let chatBridge = ChatViewModelBridge()
    private let repositoryBridge = AgentRepositoryBridge()

    private var chatSubscription: FlowSubscription?
    private var agentsSubscription: FlowSubscription?
    private var activeAgentSubscription: FlowSubscription?

    init() {
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
            guard let self else { return }
            self.agents = agents
        }

        activeAgentSubscription = repositoryBridge.observeActiveAgent { [weak self] agent in
            guard let self else { return }
            self.selectedAgentId = agent?.id
        }
    }

    // MARK: - Chat actions

    func sendMessage(_ text: String) {
        chatBridge.sendMessage(content: text)
    }

    func confirmPendingAction() {
        chatBridge.confirmAction()
    }

    func rejectPendingAction() {
        chatBridge.rejectAction()
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
            guard let self else { return }
            if let error {
                self.repositoryError = error.localizedDescription
            }
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
        let authMethod = draft.toAuthMethod()
        let systemPrompt = draft.systemPrompt.isEmpty ? nil : draft.systemPrompt
        let description = draft.description.isEmpty ? nil : draft.description

        isPerformingAgentMutation = true

        switch mode {
        case .create:
            let config = createAgentConfig(
                name: draft.name,
                url: draft.url,
                description: description,
                authMethod: authMethod,
                headers: headers,
                systemPrompt: systemPrompt
            )

            repositoryBridge.addAgent(agent: config) { [weak self] error in
                guard let self else { return }
                self.isPerformingAgentMutation = false
                if let error {
                    self.repositoryError = error.localizedDescription
                } else {
                    self.formMode = nil
                    self.setActiveAgent(id: config.id)
                }
            }
        case .edit(let existing):
            let config = updateAgentConfig(
                existing: existing,
                name: draft.name,
                url: draft.url,
                description: description,
                authMethod: authMethod,
                headers: headers,
                systemPrompt: systemPrompt
            )

            repositoryBridge.updateAgent(agent: config) { [weak self] error in
                guard let self else { return }
                self.isPerformingAgentMutation = false
                if let error {
                    self.repositoryError = error.localizedDescription
                } else {
                    self.formMode = nil
                }
            }
        }
    }

    func deleteAgent(id: String) {
        repositoryBridge.deleteAgent(agentId: id) { [weak self] error in
            guard let self else { return }
            if let error {
                self.repositoryError = error.localizedDescription
            }
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
        description = snapshot.description ?? ""
        systemPrompt = snapshot.systemPrompt ?? ""
        headers = snapshot.customHeaders.map { HeaderField(key: $0.key, value: $0.value) }
        authSelection = AuthMethodSelection(snapshot.authMethod)

        switch snapshot.authMethod {
        case let auth as AuthMethodApiKey:
            apiKey = auth.key
            apiHeaderName = auth.headerName
        case let auth as AuthMethodBearerToken:
            bearerToken = auth.token
        case let auth as AuthMethodBasicAuth:
            basicUsername = auth.username
            basicPassword = auth.password
        case let auth as AuthMethodOAuth2:
            oauthClientId = auth.clientId
            oauthClientSecret = auth.clientSecret ?? ""
            oauthAuthorizationURL = auth.authorizationUrl
            oauthTokenURL = auth.tokenUrl
            oauthScopes = auth.scopes.compactMap { $0 as? String }.joined(separator: ", ")
            oauthAccessToken = auth.accessToken ?? ""
            oauthRefreshToken = auth.refreshToken ?? ""
        case let auth as AuthMethodCustom:
            customType = auth.type
            customConfiguration = headersFromMap(map: auth.config).map { HeaderField(key: $0.key, value: $0.value) }
        default:
            break
        }
    }

    func toAuthMethod() -> AuthMethod {
        switch authSelection {
        case .none:
            return AuthMethodNone()
        case .apiKey:
            return AuthMethodApiKey(key: apiKey, headerName: apiHeaderName)
        case .bearer:
            return AuthMethodBearerToken(token: bearerToken)
        case .basic:
            return AuthMethodBasicAuth(username: basicUsername, password: basicPassword)
        case .oauth:
            let scopes = oauthScopes
                .split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            return createOAuth2Auth(
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
            return createCustomAuth(type: customType, entries: entries)
        }
    }
}

enum AuthMethodSelection: String, CaseIterable, Identifiable {
    case none
    case apiKey
    case bearer
    case basic
    case oauth
    case custom

    init(_ authMethod: AuthMethod) {
        switch authMethod {
        case is AuthMethodApiKey: self = .apiKey
        case is AuthMethodBearerToken: self = .bearer
        case is AuthMethodBasicAuth: self = .basic
        case is AuthMethodOAuth2: self = .oauth
        case is AuthMethodCustom: self = .custom
        default: self = .none
        }
    }

    var id: String { rawValue }

    var title: String {
        switch self {
        case .none: return "None"
        case .apiKey: return "API Key"
        case .bearer: return "Bearer Token"
        case .basic: return "Basic Auth"
        case .oauth: return "OAuth 2.0"
        case .custom: return "Custom"
        }
    }
}

struct HeaderField: Identifiable, Hashable {
    let id: UUID = UUID()
    var key: String
    var value: String

    func toHeaderEntry() -> HeaderEntry? {
        guard !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return HeaderEntry(key: key, value: value)
    }
}
