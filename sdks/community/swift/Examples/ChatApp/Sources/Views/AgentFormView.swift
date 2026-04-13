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

import SwiftUI

struct AgentFormView: View {
    @EnvironmentObject private var store: ChatAppStore
    @Environment(\.dismiss) private var dismiss

    let mode: AgentFormMode

    private var title: String {
        switch mode {
        case .create: return "New Agent"
        case .edit(let config): return "Edit \(config.name)"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                detailsSection
                authenticationSection
                headersSection
                previewSection
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        store.dismissAgentForm()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: store.saveAgent)
                        .disabled(!store.draft.isValid)
                }
            }
        }
        .onChange(of: store.formMode) { mode in
            if mode == nil { dismiss() }
        }
    }

    // MARK: - Sections

    private var detailsSection: some View {
        Section("Details") {
            TextField("Name", text: bind(\.name))
            TextField("Endpoint URL", text: bind(\.url))
                .textContentType(.URL)
                .keyboardType(.URL)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            TextField("Description (optional)", text: bind(\.description), axis: .vertical)
                .lineLimit(1 ... 3)
            TextField("System Prompt (optional)", text: bind(\.systemPrompt), axis: .vertical)
                .lineLimit(1 ... 6)
        }
    }

    private var authenticationSection: some View {
        Section("Authentication") {
            Picker("Method", selection: bind(\.authSelection)) {
                ForEach(AuthMethodSelection.allCases) { method in
                    Text(method.title).tag(method)
                }
            }
            .pickerStyle(.menu)

            switch store.draft.authSelection {
            case .none:
                Text("No authentication headers will be added.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            case .apiKey:
                TextField("API Key", text: bind(\.apiKey))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                TextField("Header Name", text: bind(\.apiHeaderName))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            case .bearerToken:
                SecureField("Bearer Token", text: bind(\.bearerToken))
            case .basicAuth:
                TextField("Username", text: bind(\.basicUsername))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                SecureField("Password", text: bind(\.basicPassword))
            case .custom:
                TextField("Auth Type", text: bind(\.customAuthType))
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                KeyValueEditor(items: bind(\.customConfiguration))
            }
        }
    }

    private var headersSection: some View {
        Section("Custom Headers") {
            KeyValueEditor(items: bind(\.customHeaders))
        }
    }

    @ViewBuilder
    private var previewSection: some View {
        let hasContent = !store.draft.description.isEmpty
            || !store.draft.systemPrompt.isEmpty
            || !store.draft.customHeaders.isEmpty

        Section("Preview") {
            if !hasContent {
                Text("Configure a system prompt, description, or headers to preview.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    if !store.draft.description.isEmpty {
                        previewBlock(
                            label: "Description",
                            icon: "text.justify",
                            body: store.draft.description
                        )
                    }
                    if !store.draft.systemPrompt.isEmpty {
                        previewBlock(
                            label: "System Prompt",
                            icon: "sparkles",
                            body: store.draft.systemPrompt
                        )
                    }
                    if !store.draft.customHeaders.isEmpty {
                        Label("Headers", systemImage: "tray.full")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        ForEach(store.draft.customHeaders) { header in
                            HStack {
                                Text(header.key).font(.caption)
                                Spacer()
                                Text(header.value)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
    }

    private func previewBlock(label: String, icon: String, body: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Label(label, systemImage: icon)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(body)
                .font(.callout)
        }
    }

    // MARK: - Binding helper

    private func bind<T>(_ keyPath: WritableKeyPath<AgentDraft, T>) -> Binding<T> {
        Binding(
            get: { store.draft[keyPath: keyPath] },
            set: { store.draft[keyPath: keyPath] = $0 }
        )
    }
}

// MARK: - KeyValueEditor

private struct KeyValueEditor: View {
    @Binding var items: [HeaderField]

    var body: some View {
        ForEach($items) { $item in
            HStack {
                TextField("Key", text: $item.key)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                TextField("Value", text: $item.value)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }
        }

        Button {
            items.append(HeaderField())
        } label: {
            Label("Add Header", systemImage: "plus.circle")
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
