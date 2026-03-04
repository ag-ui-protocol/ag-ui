import SwiftUI
import MarkdownUI
import shared

struct ChatView: View {
    @EnvironmentObject private var store: ChatAppStore

    let state: ChatStateSnapshot
    let onSend: (String) -> Void

    @State private var messageText: String = ""

    var body: some View {
        let backgroundColor = state.background.color(default: Color(UIColor.systemBackground))

        Group {
            if state.activeAgent == nil {
                ContentUnavailableView(
                    "Select an agent",
                    systemImage: "person.crop.circle.badge.questionmark",
                    description: Text("Choose or create an agent to begin chatting.")
                )
                .padding()
            } else {
                VStack(spacing: 0) {
                    conversationScrollView

                    if let ephemeral = state.ephemeralMessage {
                        EphemeralBanner(message: ephemeral)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    Divider()
                    inputArea
                }
                .background(backgroundColor)
            }
        }
        .animation(.default, value: state.messages.count)
    }

    private var conversationScrollView: some View {
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
        .background(state.background.color(default: Color(UIColor.systemGroupedBackground)))
            .onChange(of: state.messages.last?.id) { id in
                guard let id else { return }
                withAnimation {
                    proxy.scrollTo(id, anchor: .bottom)
                }
            }
        }
    }

    private var inputArea: some View {
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
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Waiting for response…")
                        .font(.footnote)
                        .foregroundColor(.secondary)
                    Spacer()
                    Button("Cancel", role: .cancel, action: store.cancelStreaming)
                }
            }
        }
        .padding()
        .background(Material.bar)
    }
}

private extension BackgroundSnapshot {
    func color(default defaultColor: Color) -> Color {
        guard let hex = colorHex?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "#", with: ""),
              let value = UInt64(hex, radix: 16) else {
            return defaultColor
        }

        switch hex.count {
        case 6:
            let red = Double((value & 0xFF0000) >> 16) / 255.0
            let green = Double((value & 0x00FF00) >> 8) / 255.0
            let blue = Double(value & 0x0000FF) / 255.0
            return Color(red: red, green: green, blue: blue)
        case 8:
            // Expect RRGGBBAA ordering from the tool.
            let red = Double((value & 0xFF000000) >> 24) / 255.0
            let green = Double((value & 0x00FF0000) >> 16) / 255.0
            let blue = Double((value & 0x0000FF00) >> 8) / 255.0
            let alpha = Double(value & 0x000000FF) / 255.0
            return Color(red: red, green: green, blue: blue, opacity: alpha)
        default:
            return defaultColor
        }
    }
}

private struct ChatMessageBubble: View {
    let message: DisplayMessageSnapshot

    private var alignment: HorizontalAlignment {
        switch message.role {
        case MessageRole.user: return .trailing
        default: return .leading
        }
    }

    private var bubbleColor: Color {
        switch message.role {
        case MessageRole.user: return Color.accentColor
        case MessageRole.assistant: return Color(UIColor.secondarySystemBackground)
        case MessageRole.system: return Color(UIColor.systemGray5)
        case MessageRole.error: return Color.red.opacity(0.15)
        case MessageRole.toolCall: return Color.yellow.opacity(0.2)
        case MessageRole.stepInfo: return Color.blue.opacity(0.12)
        default: return Color(UIColor.tertiarySystemBackground)
        }
    }

    private var textColor: Color {
        switch message.role {
        case MessageRole.user: return .white
        case MessageRole.error: return .red
        default: return .primary
        }
    }

    private var leadingIcon: String? {
        switch message.role {
        case MessageRole.assistant: return "sparkles"
        case MessageRole.system: return "info.circle"
        case MessageRole.error: return "exclamationmark.triangle"
        case MessageRole.toolCall: return "wrench.adjustable"
        case MessageRole.stepInfo: return "bolt.fill"
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
                    if message.content.isEmpty && message.isStreaming {
                        Text("…")
                            .foregroundColor(textColor)
                            .font(.body)
                    } else {
                        Markdown(message.content)
                            .markdownTheme(.basic)
                            .markdownTextStyle(\.text) {
                                ForegroundColor(textColor)
                            }
                            .markdownTextStyle(\.strong) {
                                FontWeight(.heavy)
                                ForegroundColor(textColor)
                                BackgroundColor(textColor.opacity(alignment == .trailing ? 0.3 : 0.15))
                            }
                            .markdownTextStyle(\.link) {
                                ForegroundColor(textColor)
                            }
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
                .padding(12)
                .background(bubbleColor)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

                Text(
                    Date(timeIntervalSince1970: TimeInterval(message.timestamp) / 1000)
                        .formatted(date: .omitted, time: .shortened)
                )
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
            Image(systemName: message.role == MessageRole.toolCall ? "wrench.adjustable" : "bolt.fill")
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
