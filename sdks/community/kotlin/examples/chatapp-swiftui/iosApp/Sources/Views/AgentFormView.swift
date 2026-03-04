import SwiftUI
import shared

struct AgentFormView: View {
    @EnvironmentObject private var store: ChatAppStore
    @Environment(\.dismiss) private var dismiss

    let mode: AgentFormMode

    private var title: String {
        switch mode {
        case .create: return "New Agent"
        case .edit(let agent): return "Edit \(agent.name)"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                agentDetailsSection
                authenticationSection
                headersSection
                systemPromptSection
                if store.isPerformingAgentMutation {
                    Section {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                    }
                }
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { store.dismissAgentForm(); dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: saveAgent) {
                        Text("Save")
                    }
                    .disabled(!isValid)
                }
            }
        }
        .onChange(of: store.formMode) { mode in
            if mode == nil {
                dismiss()
            }
        }
    }

    private var agentDetailsSection: some View {
        Section("Details") {
            TextField("Name", text: binding(\.name))
            TextField("Endpoint URL", text: binding(\.url))
                .textContentType(.URL)
                .keyboardType(.URL)
            TextField("Description", text: binding(\.description), axis: .vertical)
            TextField("System Prompt", text: binding(\.systemPrompt), axis: .vertical)
        }
    }

    private var authenticationSection: some View {
        Section("Authentication") {
            Picker("Method", selection: binding(\.authSelection)) {
                ForEach(AuthMethodSelection.allCases) { method in
                    Text(method.title).tag(method)
                }
            }
            .pickerStyle(.segmented)

            switch store.draft.authSelection {
            case .none:
                Text("No authentication headers will be added.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            case .apiKey:
                TextField("API Key", text: binding(\.apiKey))
                TextField("Header Name", text: binding(\.apiHeaderName))
            case .bearerToken:
                SecureField("Bearer Token", text: binding(\.bearerToken))
            case .basicAuth:
                TextField("Username", text: binding(\.basicUsername))
                SecureField("Password", text: binding(\.basicPassword))
            case .oauth2:
                TextField("Client ID", text: binding(\.oauthClientId))
                SecureField("Client Secret", text: binding(\.oauthClientSecret))
                TextField("Authorization URL", text: binding(\.oauthAuthorizationURL))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                TextField("Token URL", text: binding(\.oauthTokenURL))
                    .textContentType(.URL)
                    .keyboardType(.URL)
                TextField("Scopes (comma separated)", text: binding(\.oauthScopes))
                TextField("Access Token", text: binding(\.oauthAccessToken))
                TextField("Refresh Token", text: binding(\.oauthRefreshToken))
            case .custom:
                TextField("Type", text: binding(\.customType))
                KeyValueEditor(title: "Configuration", items: binding(\.customConfiguration))
            }
        }
    }

    private var headersSection: some View {
        Section("Custom Headers") {
            KeyValueEditor(title: "Headers", items: binding(\.headers))
        }
    }

    private var systemPromptSection: some View {
        Section("Preview") {
            if store.draft.headers.isEmpty, store.draft.systemPrompt.isEmpty, store.draft.description.isEmpty {
                Text("Configure headers, description, or prompt to preview.")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if !store.draft.description.isEmpty {
                        Label("Description", systemImage: "text.justify")
                            .font(.caption)
                        Text(store.draft.description)
                    }
                    if !store.draft.systemPrompt.isEmpty {
                        Label("System Prompt", systemImage: "sparkles")
                            .font(.caption)
                        Text(store.draft.systemPrompt)
                            .font(.callout)
                    }
                    if !store.draft.headers.isEmpty {
                        Label("Headers", systemImage: "tray.full")
                            .font(.caption)
                        ForEach(store.draft.headers) { header in
                            HStack {
                                Text(header.key)
                                    .font(.caption)
                                Spacer()
                                Text(header.value)
                                    .font(.caption)
                            }
                        }
                    }
                }
            }
        }
    }

    private var isValid: Bool {
        !store.draft.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
        !store.draft.url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func saveAgent() {
        store.saveAgent()
    }

    private func binding<T>(_ keyPath: WritableKeyPath<AgentDraft, T>) -> Binding<T> {
        Binding(
            get: { store.draft[keyPath: keyPath] },
            set: { store.draft[keyPath: keyPath] = $0 }
        )
    }
}

private struct KeyValueEditor: View {
    let title: String
    @Binding var items: [HeaderField]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach($items) { $item in
                HStack {
                    TextField("Key", text: $item.key)
                    TextField("Value", text: $item.value)
                }
            }

            Button {
                items.append(HeaderField(key: "", value: ""))
            } label: {
                Label("Add \(title.hasSuffix("s") ? String(title.dropLast()) : title)", systemImage: "plus.circle")
            }
            .buttonStyle(.borderless)

            if !items.isEmpty {
                Button(role: .destructive) {
                    items.removeLast()
                } label: {
                    Label("Remove Last", systemImage: "trash")
                }
                .buttonStyle(.borderless)
            }
        }
    }
}
