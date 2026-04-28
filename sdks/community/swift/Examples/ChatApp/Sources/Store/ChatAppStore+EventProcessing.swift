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

// MARK: - ChatAppStore + Event Processing

extension ChatAppStore {

    // MARK: - Event dispatcher

    /// Processes a single AG-UI event and updates `state` accordingly.
    ///
    /// Marked `internal` so tests can inject events directly without a live agent.
    func processEvent(_ event: any AGUIEvent) {
        switch event {

        // MARK: Text messages (streaming assembly)

        case let e as TextMessageStartEvent:
            let msg = DisplayMessage(
                id: e.messageId,
                role: .assistant,
                content: "",
                timestamp: .now,
                isStreaming: true
            )
            streamingMessageIndices[e.messageId] = state.messages.count
            state.messages.append(msg)

        case let e as TextMessageContentEvent:
            if let idx = streamingMessageIndices[e.messageId] {
                state.messages[idx].content += e.delta
            }

        case let e as TextMessageEndEvent:
            if let idx = streamingMessageIndices[e.messageId] {
                state.messages[idx].isStreaming = false
                streamingMessageIndices.removeValue(forKey: e.messageId)
            }

        // MARK: Tool calls (ephemeral .toolCall slot + args preview)

        case let e as ToolCallStartEvent:
            toolCallArgBuffer[e.toolCallId] = ""
            showEphemeral(
                DisplayMessage(
                    id: e.toolCallId,
                    role: .toolCall(name: e.toolCallName),
                    content: "Calling \(e.toolCallName)…",
                    timestamp: .now
                ),
                slot: .toolCall
            )

        case let e as ToolCallArgsEvent:
            // Phase 2A: buffer arg deltas and update the ephemeral preview.
            toolCallArgBuffer[e.toolCallId, default: ""] += e.delta
            let preview = summarizeArguments(toolCallArgBuffer[e.toolCallId] ?? "")
            if var msg = state.ephemeralSlots[.toolCall] {
                msg.content = preview
                state.ephemeralSlots[.toolCall] = msg
            }

        case let e as ToolCallEndEvent:
            toolCallArgBuffer.removeValue(forKey: e.toolCallId)
            scheduleEphemeralDismissal(for: .toolCall)

        // MARK: Steps (ephemeral .step slot)

        case let e as StepStartedEvent:
            showEphemeral(
                DisplayMessage(
                    id: UUID().uuidString,
                    role: .stepInfo(name: e.stepName),
                    content: e.stepName,
                    timestamp: .now
                ),
                slot: .step
            )

        case is StepFinishedEvent:
            // Step dismisses immediately — no scheduled delay.
            ephemeralDismissTasks[.step]?.cancel()
            ephemeralDismissTasks.removeValue(forKey: .step)
            state.ephemeralSlots[.step] = nil

        // MARK: Run lifecycle

        case let e as RunErrorEvent:
            state.error = e.error.message
            appendSupplemental(SupplementalMessage(
                id: UUID().uuidString,
                kind: .error(message: e.error.message),
                timestamp: .now
            ))

        // MARK: Messages snapshot (authoritative history replacement)

        case let e as MessagesSnapshotEvent:
            rebuildMessages(from: e)

        // MARK: A2UI surfaces (Phase 4)

        case let e as ActivitySnapshotEvent where e.activityType == "a2ui-surface":
            processA2UISnapshot(e)

        case let e as ActivityDeltaEvent where e.activityType == "a2ui-surface":
            processA2UIDelta(e)

        // MARK: Custom events (e.g. server-sent change_background)

        case let e as CustomEvent:
            handleCustomEvent(e)

        default:
            break
        }
    }

    // MARK: - Supplemental messages

    /// Appends a system-level message to the chat list.
    ///
    /// `internal` so `buildAgent(from:)` in `ChatAppStore.swift` can call it.
    func appendSupplemental(_ message: SupplementalMessage) {
        state.supplementalMessages.append(message)
    }

    // MARK: - Ephemeral slot management

    /// Sets the ephemeral message for `slot`, cancelling any pending dismissal first.
    private func showEphemeral(_ message: DisplayMessage, slot: EphemeralSlot) {
        ephemeralDismissTasks[slot]?.cancel()
        ephemeralDismissTasks.removeValue(forKey: slot)
        state.ephemeralSlots[slot] = message
    }

    /// Schedules dismissal of `slot` after its configured `dismissDelay`.
    ///
    /// Slots with `dismissDelay == nil` (i.e. `.step`) are cleared synchronously in
    /// the `StepFinishedEvent` case — this method is a no-op for those slots.
    private func scheduleEphemeralDismissal(for slot: EphemeralSlot) {
        guard let delay = slot.dismissDelay else { return }
        ephemeralDismissTasks[slot]?.cancel()
        ephemeralDismissTasks[slot] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.state.ephemeralSlots[slot] = nil
            self?.ephemeralDismissTasks.removeValue(forKey: slot)
        }
    }

    // MARK: - Message snapshot reconstruction

    private func rebuildMessages(from event: MessagesSnapshotEvent) {
        guard let rawArray = try? event.parsedMessages() as? [[String: Any]] else { return }
        var rebuilt = rawArray.compactMap { displayMessage(from: $0) }

        // Phase 1C: Correlate the pending optimistic user message.
        if let pendingId = pendingUserMessageId,
           let pending = state.messages.first(where: { $0.id == pendingId }) {
            let isEchoed = rebuilt.contains { $0.role == .user && $0.content == pending.content }
            if isEchoed {
                pendingUserMessageId = nil
            } else {
                rebuilt.insert(pending, at: 0)
            }
        }

        state.messages = rebuilt
        streamingMessageIndices.removeAll()
    }

    private func displayMessage(from dict: [String: Any]) -> DisplayMessage? {
        guard
            let id = dict["id"] as? String,
            let role = dict["role"] as? String
        else { return nil }

        let content = dict["content"] as? String ?? ""

        let displayRole: DisplayMessageRole
        switch role {
        case "user": displayRole = .user
        case "assistant": displayRole = .assistant
        case "system": displayRole = .system
        default: return nil  // skip tool/activity messages from the display list
        }
        return DisplayMessage(id: id, role: displayRole, content: content, timestamp: .now)
    }

    // MARK: - Custom event handling

    private func handleCustomEvent(_ event: CustomEvent) {
        guard event.customType == "change_background",
              let payload = try? event.parsedData() as? [String: Any],
              let hex = payload["hex"] as? String ?? payload["color"] as? String
        else { return }
        state.backgroundHex = hex
    }

    // MARK: - Args summary (Phase 2A)

    /// Truncates `json` to 80 characters and appends `…` if longer.
    private func summarizeArguments(_ json: String) -> String {
        let trimmed = json.trimmingCharacters(in: .whitespaces)
        guard trimmed.count > 80 else { return trimmed }
        return String(trimmed.prefix(80)) + "…"
    }
}
