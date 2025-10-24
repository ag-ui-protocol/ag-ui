import SwiftUI
import shared

struct RootView: View {
    @EnvironmentObject private var store: ChatAppStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var agentToEdit: AgentSnapshot?

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    AgentListView(
                        agents: store.agents,
                        selectedAgentId: store.selectedAgentId,
                        onSelect: { store.setActiveAgent(id: $0) },
                        onAdd: store.presentCreateAgent,
                        onEdit: { store.presentEditAgent(agent: $0) },
                        onDelete: { store.deleteAgent(id: $0) }
                    )
                    .frame(minWidth: 280)
                } detail: {
                    ChatView(state: store.chatState) { message in
                        store.sendMessage(message)
                    }
                    .navigationTitle(store.chatState.activeAgent?.name ?? "Chat")
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button {
                                store.presentCreateAgent()
                            } label: {
                                Label("Add Agent", systemImage: "plus")
                            }
                        }
                    }
                }
            } else {
                NavigationStack {
                    ChatView(state: store.chatState) { message in
                        store.sendMessage(message)
                    }
                    .navigationTitle(store.chatState.activeAgent?.name ?? "Chat")
                    .toolbar {
                        ToolbarItem(placement: .navigationBarLeading) {
                            Menu {
                                AgentListMenu(
                                    agents: store.agents,
                                    activeId: store.selectedAgentId,
                                    onSelect: store.setActiveAgent,
                                    onEdit: store.presentEditAgent,
                                    onDelete: store.deleteAgent,
                                    onCreate: store.presentCreateAgent
                                )
                            } label: {
                                Label("Agents", systemImage: "person.3.sequence")
                            }
                        }

                        ToolbarItem(placement: .navigationBarTrailing) {
                            Button {
                                store.presentCreateAgent()
                            } label: {
                                Label("Add Agent", systemImage: "plus")
                            }
                        }
                    }
                }
            }
        }
        .sheet(item: Binding(
            get: { store.formMode.map(FormSheetWrapper.init) },
            set: { newValue in
                if newValue == nil { store.dismissAgentForm() }
            }
        )) { wrapper in
            AgentFormView(mode: wrapper.mode)
                .environmentObject(store)
        }
        .alert(item: Binding(
            get: { store.repositoryError.map { IdentifiableError(message: $0) } },
            set: { _ in store.repositoryError = nil }
        )) { error in
            Alert(title: Text("Error"), message: Text(error.message), dismissButton: .default(Text("OK")))
        }
        .alert(isPresented: Binding(
            get: { store.chatState.error != nil },
            set: { value in if !value { store.dismissError() } }
        )) {
            Alert(
                title: Text("Conversation Error"),
                message: Text(store.chatState.error ?? "Unknown error"),
                dismissButton: .default(Text("OK"), action: store.dismissError)
            )
        }
    }
}

private struct FormSheetWrapper: Identifiable, Equatable {
    let mode: AgentFormMode

    var id: String {
        switch mode {
        case .create:
            return "create"
        case .edit(let agent):
            return "edit-\(agent.id)"
        }
    }

    static func == (lhs: FormSheetWrapper, rhs: FormSheetWrapper) -> Bool {
        lhs.id == rhs.id
    }
}

private struct IdentifiableError: Identifiable {
    let id = UUID()
    let message: String
}
