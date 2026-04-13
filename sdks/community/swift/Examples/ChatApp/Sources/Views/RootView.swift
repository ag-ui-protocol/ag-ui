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

struct RootView: View {
    @EnvironmentObject private var store: ChatAppStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                regularLayout
            } else {
                compactLayout
            }
        }
        // Agent form sheet
        .sheet(item: Binding(
            get: { store.formMode.map(FormSheetItem.init) },
            set: { newVal in if newVal == nil { store.dismissAgentForm() } }
        )) { item in
            AgentFormView(mode: item.mode)
                .environmentObject(store)
        }
        // Repository error alert
        .alert(
            "Error",
            isPresented: Binding(
                get: { store.repositoryError != nil },
                set: { _ in store.repositoryError = nil }
            )
        ) {
            Button("OK", role: .cancel) { store.repositoryError = nil }
        } message: {
            Text(store.repositoryError ?? "")
        }
        // Conversation error alert
        .alert(
            "Conversation Error",
            isPresented: Binding(
                get: { store.state.error != nil },
                set: { _ in store.dismissError() }
            )
        ) {
            Button("OK", role: .cancel) { store.dismissError() }
        } message: {
            Text(store.state.error ?? "")
        }
    }

    // MARK: - Layout variants

    private var regularLayout: some View {
        NavigationSplitView {
            AgentListView(
                agents: store.agents,
                selectedId: store.selectedAgentId,
                onSelect: { store.setActiveAgent(id: $0) },
                onAdd: store.presentCreateAgent,
                onEdit: store.presentEditAgent,
                onDelete: { store.deleteAgent(id: $0) }
            )
            .frame(minWidth: 280)
        } detail: {
            ChatView(state: store.state) { store.sendMessage($0) }
                .navigationTitle(store.state.activeAgent?.name ?? "Chat")
                .toolbar {
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: store.presentCreateAgent) {
                            Label("Add Agent", systemImage: "plus")
                        }
                    }
                }
        }
    }

    private var compactLayout: some View {
        NavigationStack {
            ChatView(state: store.state) { store.sendMessage($0) }
                .navigationTitle(store.state.activeAgent?.name ?? "Chat")
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Menu {
                            ForEach(store.agents) { agent in
                                Button {
                                    store.setActiveAgent(id: agent.id)
                                } label: {
                                    Label(
                                        agent.name,
                                        systemImage: store.selectedAgentId == agent.id
                                            ? "checkmark.circle.fill" : "circle"
                                    )
                                }
                            }
                            Divider()
                            Button(action: store.presentCreateAgent) {
                                Label("New Agent", systemImage: "plus.circle")
                            }
                        } label: {
                            Label("Agents", systemImage: "person.3.sequence")
                        }
                    }
                    ToolbarItem(placement: .navigationBarTrailing) {
                        Button(action: store.presentCreateAgent) {
                            Label("Add Agent", systemImage: "plus")
                        }
                    }
                }
        }
    }
}

// MARK: - Helpers

private struct FormSheetItem: Identifiable, Equatable {
    let mode: AgentFormMode

    var id: String {
        switch mode {
        case .create: return "create"
        case .edit(let c): return "edit-\(c.id)"
        }
    }

    static func == (lhs: FormSheetItem, rhs: FormSheetItem) -> Bool { lhs.id == rhs.id }
}
