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

import AGUICore
import Foundation

// MARK: - ChatAppStore + A2UI

extension ChatAppStore {

    // MARK: - Event processing

    /// Seeds a new A2UI surface from an activity snapshot and inserts a
    /// corresponding display message so the surface appears in the chat list.
    func processA2UISnapshot(_ event: ActivitySnapshotEvent) {
        surfaceManager.applySnapshot(event)
        state.a2uiSurfaces[event.messageId] = event.content
        upsertA2UIMessage(messageId: event.messageId)
    }

    /// Applies a JSON Patch delta to an existing A2UI surface.
    ///
    /// Silently ignores patches that arrive before their snapshot — the surface
    /// manager will throw, and the store swallows the error without crashing.
    func processA2UIDelta(_ event: ActivityDeltaEvent) {
        guard let updated = try? surfaceManager.applyDelta(event) else { return }
        state.a2uiSurfaces[event.messageId] = updated
    }

    // MARK: - Action routing

    /// Sends a user-initiated A2UI action back to the agent as a structured message.
    ///
    /// The payload is JSON-serialized and prefixed with `[A2UI Action]` so the
    /// agent can distinguish these from plain user messages.
    func handleA2UIAction(messageId: String, actionId: String, payload: [String: String]) {
        let body: [String: Any] = [
            "messageId": messageId,
            "action": actionId,
            "payload": payload
        ]
        guard
            let data = try? JSONSerialization.data(withJSONObject: body),
            let json = String(data: data, encoding: .utf8)
        else { return }
        sendMessage("[A2UI Action] \(json)")
    }

    // MARK: - Private helpers

    /// Inserts a `.a2uiSurface` display message if one for this `messageId` does not yet exist.
    private func upsertA2UIMessage(messageId: String) {
        let compositeId = "a2ui-\(messageId)"
        guard !state.messages.contains(where: { $0.id == compositeId }) else { return }
        let msg = DisplayMessage(
            id: compositeId,
            role: .a2uiSurface(messageId: messageId),
            content: "",
            timestamp: .now
        )
        state.messages.append(msg)
    }
}
