import SwiftUI
import shared

struct ChatView: View {
    @EnvironmentObject private var store: ChatAppStore

    let state: ChatStateSnapshot
    let onSend: (String) -> Void

    @State private var messageText: String = ""

    var body: some View {
        if state.activeAgent == nil {
            ContentUnavailableView(
                "Select an agent",
                systemImage: "person.crop.circle.badge.questionmark",
                description: Text("Choose or create an agent to begin chatting.")
            )
            .padding()
        } else {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 12) {
                            ForEach(state.messages, id: \.id) { message in
                                ChatMessageBubble(message: message)
                                .id(message.id)
                        }
                    }
                    .padding(.horizontal)
                    .padding(.vertical, 16)
                }
                .background(Color(UIColor.systemGroupedBackground))
                .onChange(of: state.messages.last?.id) { id in
                    guard let id else { return }
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }

            if let ephemeral = state.ephemeralMessage {
                EphemeralBanner(message: ephemeral)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let confirmation = state.pendingConfirmation {
                ConfirmationBanner(confirmation: confirmation) {
                    store.confirmPendingAction()
                } onReject: {
                    store.rejectPendingAction()
                }
            }

            Divider()

            VStack(spacing: 8) {
                HStack(alignment: .bottom, spacing: 12) {
                    TextField("Type a message", text: $messageText, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...6)
                        .disabled(!state.isConnected)

                    Button {
                        let trimmed = messageText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !trimmed.isEmpty else { return }
                        onSend(trimmed)
                        messageText = ""
                    } label: {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 18, weight: .semibold))
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!state.isConnected)
                }

                if state.isLoading {
                    HStack {
                        ProgressView()
                        Text("Waiting for response...")
                            .font(.footnote)
                            .foregroundColor(.secondary)
                        Spacer()
                        Button("Cancel", role: .cancel, action: store.cancelStreaming)
                    }
                    .padding(.horizontal, 4)
                }
            }
            .padding()
            .background(Material.bar)
        }
        .animation(.default, value: state.messages.count)
        .background(Color(UIColor.systemBackground))
    }
}

private struct ChatMessageBubble: View {
    let message: DisplayMessageSnapshot

    private var alignment: HorizontalAlignment {
        switch message.role {
        case .user: return .trailing
        default: return .leading
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case .user: return Color.accentColor
        case .assistant: return Color(UIColor.secondarySystemBackground)
        case .system: return Color(UIColor.systemGray5)
        case .error: return Color.red.opacity(0.15)
        case .tool_call: return Color.yellow.opacity(0.2)
        case .step_info: return Color.blue.opacity(0.12)
        default: return Color(UIColor.tertiarySystemBackground)
        }
    }

    private var textColor: Color {
        switch message.role {
        case .user: return .white
        case .error: return .red
        default: return .primary
        }
    }

    private var leadingIcon: String? {
        switch message.role {
        case .assistant: return "sparkles"
        case .system: return "info.circle"
        case .error: return "exclamationmark.triangle"
        case .tool_call: return "wrench.adjustable"
        case .step_info: return "bolt.fill"
        default: return nil
        }
    }

    var body: some View {
        HStack {
            if alignment == .trailing { Spacer(minLength: 40) }

            VStack(alignment: alignment == .trailing ? .trailing : .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 6) {
                    if let icon = leadingIcon {
                        Image(systemName: icon)
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Text(message.content.isEmpty && message.isStreaming ? "…" : message.content)
                        .foregroundColor(textColor)
                        .textSelection(.enabled)
                        .font(.body)
                }
                .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
                .padding(12)
                .background(bubbleColor)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text(Date(timeIntervalSince1970: TimeInterval(message.timestamp) / 1000).formatted(date: .omitted, time: .shortened))
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }

            if alignment == .leading { Spacer(minLength: 40) }
        }
    }
}

private struct EphemeralBanner: View {
    let message: DisplayMessageSnapshot

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: message.role == .tool_call ? "wrench.adjustable" : "bolt.fill")
                .foregroundColor(.accentColor)
            Text(message.content)
                .font(.footnote)
                .foregroundColor(.accentColor)
            Spacer()
        }
        .padding(12)
        .background(Color.accentColor.opacity(0.1))
    }
}

private struct ConfirmationBanner: View {
    let confirmation: UserConfirmationSnapshot
    let onConfirm: () -> Void
    let onReject: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Action Required")
                .font(.headline)
            Text(confirmation.action)
                .font(.subheadline)
            Text("Impact: \(confirmation.impact)")
                .font(.caption)
                .foregroundColor(.secondary)
            if !confirmation.details.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(confirmation.details, id: \.key) { entry in
                        HStack {
                            Text(entry.key)
                                .font(.caption)
                                .foregroundColor(.secondary)
                            Spacer()
                            Text(entry.value)
                                .font(.caption)
                        }
                    }
                }
            }
            HStack {
                Button(role: .destructive, action: onReject) {
                    Label("Reject", systemImage: "xmark.circle")
                }
                Spacer()
                Button(action: onConfirm) {
                    Label("Approve", systemImage: "checkmark.circle")
                }
                .buttonStyle(.borderedProminent)
            }
            Text("Auto expires in \(confirmation.timeout)s")
                .font(.caption2)
                .foregroundColor(.secondary)
        }
        .padding()
        .background(Material.thick)
    }
}
