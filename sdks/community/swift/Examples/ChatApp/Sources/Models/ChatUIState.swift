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

/// Snapshot of the chat UI that `ChatAppStore` publishes to SwiftUI views.
struct ChatUIState: Sendable {
    var messages: [DisplayMessage]
    /// Active ephemeral banners, keyed by slot type.
    ///
    /// Multiple slots can coexist. `.step` dismisses immediately on `StepFinishedEvent`;
    /// `.toolCall` dismisses 1 second after `ToolCallEndEvent`.
    var ephemeralSlots: [EphemeralSlot: DisplayMessage]
    /// System-level messages (connection status, inline errors) injected alongside chat messages.
    var supplementalMessages: [SupplementalMessage]
    var isLoading: Bool
    /// `true` when an active agent is configured and ready to receive messages.
    var isConnected: Bool
    var error: String?
    /// Hex color string for the chat background (e.g. `"FF5733"` or `"FF5733CC"`).
    var backgroundHex: String?
    var activeAgent: AgentConfig?
    /// Phase 4: Raw JSON data for each A2UI surface, keyed by `messageId`.
    ///
    /// Populated by `ActivitySnapshotEvent` and updated on each `ActivityDeltaEvent`.
    /// Surfaces are cleared when the active agent changes.
    var a2uiSurfaces: [String: Data]

    init(
        messages: [DisplayMessage] = [],
        ephemeralSlots: [EphemeralSlot: DisplayMessage] = [:],
        supplementalMessages: [SupplementalMessage] = [],
        isLoading: Bool = false,
        isConnected: Bool = false,
        error: String? = nil,
        backgroundHex: String? = nil,
        activeAgent: AgentConfig? = nil,
        a2uiSurfaces: [String: Data] = [:]
    ) {
        self.messages = messages
        self.ephemeralSlots = ephemeralSlots
        self.supplementalMessages = supplementalMessages
        self.isLoading = isLoading
        self.isConnected = isConnected
        self.error = error
        self.backgroundHex = backgroundHex
        self.activeAgent = activeAgent
        self.a2uiSurfaces = a2uiSurfaces
    }

    /// Unified list of all rows shown in the chat message list.
    ///
    /// Merges agent `messages` and `supplementalMessages`, sorted by timestamp
    /// so supplemental events (connection confirmation, inline errors) appear
    /// at the correct point in the conversation timeline.
    var chatRows: [ChatRow] {
        let agentRows = messages.map { ChatRow.agent($0) }
        let suppRows = supplementalMessages.map { ChatRow.supplemental($0) }
        return (agentRows + suppRows).sorted { $0.timestamp < $1.timestamp }
    }
}
