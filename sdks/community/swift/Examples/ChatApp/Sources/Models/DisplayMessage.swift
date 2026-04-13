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

import Foundation

// MARK: - DisplayMessage

/// A UI-only model that represents a single row in the chat message list.
///
/// Built from AG-UI protocol events in `ChatAppStore`; not persisted.
struct DisplayMessage: Identifiable, Sendable {
    let id: String
    let role: DisplayMessageRole
    var content: String
    let timestamp: Date
    /// `true` while `TextMessageContent` events are still arriving.
    var isStreaming: Bool
    /// `true` while the user message is waiting for agent confirmation.
    ///
    /// Set on the optimistic message created by `sendMessage`; cleared once the
    /// agent echoes the message back in a `MessagesSnapshotEvent`, or on
    /// cancellation / error.
    var isSending: Bool

    init(
        id: String = UUID().uuidString,
        role: DisplayMessageRole,
        content: String,
        timestamp: Date = .now,
        isStreaming: Bool = false,
        isSending: Bool = false
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.isStreaming = isStreaming
        self.isSending = isSending
    }

    // MARK: - Phase 3: Animation state helpers

    /// `true` when the agent has started responding but no tokens have arrived yet.
    ///
    /// Drives the animated typing indicator in `MessageBubbleView`.
    var showsTypingIndicator: Bool { isStreaming && content.isEmpty }

    /// `true` when tokens are actively streaming in and there is content to show.
    ///
    /// Drives the blinking cursor appended to streaming text in `MessageBubbleView`.
    var showsStreamingCursor: Bool { isStreaming && !content.isEmpty }
}

// MARK: - DisplayMessageRole

enum DisplayMessageRole: Sendable, Hashable {
    case user
    case assistant
    case system
    case error
    case toolCall(name: String)
    case stepInfo(name: String)
    /// An A2UI generative-UI surface. The associated `messageId` keys into
    /// `ChatUIState.a2uiSurfaces` for the raw JSON data.
    case a2uiSurface(messageId: String)
}
