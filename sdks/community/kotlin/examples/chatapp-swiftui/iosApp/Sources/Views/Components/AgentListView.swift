import SwiftUI
import shared

struct AgentListView: View {
    let agents: [AgentSnapshot]
    let selectedAgentId: String?
    let onSelect: (String?) -> Void
    let onAdd: () -> Void
    let onEdit: (AgentSnapshot) -> Void
    let onDelete: (String) -> Void

    var body: some View {
        List {
            Section(header: Text("Agents")) {
                if agents.isEmpty {
                    ContentUnavailableView(
                        "No agents",
                        systemImage: "person.crop.circle.badge.questionmark",
                        description: Text("Add an agent to start chatting.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(agents, id: \.id) { agent in
                        AgentRow(agent: agent, isActive: agent.id == selectedAgentId)
                            .contentShape(Rectangle())
                            .onTapGesture { onSelect(agent.id) }
                            .contextMenu {
                                Button("Chat with \(agent.name)") { onSelect(agent.id) }
                                Button("Edit") { onEdit(agent) }
                                Button(role: .destructive) {
                                    onDelete(agent.id)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button("Edit") { onEdit(agent) }
                                    .tint(.blue)

                                Button(role: .destructive) {
                                    onDelete(agent.id)
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                    }
                }
            }

            Section {
                Button {
                    onAdd()
                } label: {
                    Label("Add Agent", systemImage: "plus")
                }
            }
        }
        .listStyle(.insetGrouped)
    }
}

private struct AgentRow: View {
    let agent: AgentSnapshot
    let isActive: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: isActive ? "bubble.left.and.bubble.right.fill" : "bubble.left")
                .foregroundColor(isActive ? .accentColor : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(agent.name)
                        .font(.headline)
                    if isActive {
                        Capsule()
                            .fill(Color.accentColor.opacity(0.2))
                            .overlay(Text("Active").font(.caption).foregroundColor(.accentColor))
                            .frame(width: 60, height: 20)
                    }
                }
                Text(agent.url)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                let description = agent.description_ ?? ""
                if !description.isEmpty {
                    Text(description)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer()
        }
        .padding(.vertical, 6)
    }
}

struct AgentListMenu: View {
    let agents: [AgentSnapshot]
    let activeId: String?
    let onSelect: (String?) -> Void
    let onEdit: (AgentSnapshot) -> Void
    let onDelete: (String) -> Void
    let onCreate: () -> Void

    var body: some View {
        if agents.isEmpty {
            Button("Add Agent", action: onCreate)
        } else {
            Section("Active") {
                ForEach(agents, id: \.id) { agent in
                    Button {
                        onSelect(agent.id)
                    } label: {
                        Label(agent.name, systemImage: agent.id == activeId ? "checkmark" : "person")
                    }
                }
            }

            Section("Manage") {
                ForEach(agents, id: \.id) { agent in
                    Button("Edit \(agent.name)") { onEdit(agent) }
                }
                ForEach(agents, id: \.id) { agent in
                    Button(role: .destructive) {
                        onDelete(agent.id)
                    } label: {
                        Label("Remove \(agent.name)", systemImage: "trash")
                    }
                }
                Button("Add Agent", action: onCreate)
            }
        }
    }
}
