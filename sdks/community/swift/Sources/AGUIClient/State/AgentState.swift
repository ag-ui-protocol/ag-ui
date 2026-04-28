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

/// Represents a snapshot of changes to agent state after processing an event.
///
/// Each emission from `applyEvents()` carries only the fields that changed.
/// Fields not changed in this emission are `nil`.
///
/// This design mirrors Kotlin's AgentState: callers accumulate values from
/// successive emissions rather than replacing the entire state on each event.
public struct AgentState: Sendable {
    /// Updated message list, or `nil` if messages did not change.
    public var messages: [any Message]?
    /// Updated thinking state, or `nil` if thinking state did not change.
    public var thinking: ThinkingTelemetryState?
    /// Updated JSON state, or `nil` if state did not change.
    public var state: State?
    /// Updated raw events list, or `nil` if raw events did not change.
    public var rawEvents: [RawEvent]?
    /// Updated custom events list, or `nil` if custom events did not change.
    public var customEvents: [CustomEvent]?

    public init(
        messages: [any Message]? = nil,
        thinking: ThinkingTelemetryState? = nil,
        state: State? = nil,
        rawEvents: [RawEvent]? = nil,
        customEvents: [CustomEvent]? = nil
    ) {
        self.messages = messages
        self.thinking = thinking
        self.state = state
        self.rawEvents = rawEvents
        self.customEvents = customEvents
    }
}
