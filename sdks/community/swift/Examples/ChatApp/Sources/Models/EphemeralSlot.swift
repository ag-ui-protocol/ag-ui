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

/// Identifies a named slot in the ephemeral banner strip.
///
/// Each slot is independent — multiple slots can be visible simultaneously.
/// Slots differ in their display priority and dismissal behaviour, mirroring
/// the Kotlin Compose `chatapp` implementation.
enum EphemeralSlot: Hashable, CaseIterable, Comparable, Sendable {
    /// Shown while a tool call is in flight.
    /// Dismissed 1 second after `ToolCallEndEvent` arrives.
    case toolCall
    /// Shown while a reasoning step is active.
    /// Dismissed immediately (synchronously) when `StepFinishedEvent` arrives.
    case step

    /// Lower value renders closer to the top of the banner strip.
    var displayPriority: Int {
        switch self {
        case .step: return 0
        case .toolCall: return 1
        }
    }

    /// The delay to wait before clearing this slot from the banner strip.
    ///
    /// `nil` means dismiss immediately — no `Task.sleep` is scheduled.
    var dismissDelay: Duration? {
        switch self {
        case .toolCall: return .seconds(1)
        case .step: return nil
        }
    }

    static func < (lhs: EphemeralSlot, rhs: EphemeralSlot) -> Bool {
        lhs.displayPriority < rhs.displayPriority
    }
}
