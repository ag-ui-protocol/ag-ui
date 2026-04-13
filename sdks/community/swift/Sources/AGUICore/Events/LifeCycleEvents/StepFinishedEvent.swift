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

/// Event indicating that an execution step has completed.
///
/// This event marks the end of a named step in the agent's workflow.
/// It can be used to track progress and measure step execution times.
public struct StepFinishedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The name of the step that has finished.
    public let stepName: String

    /// Optional timestamp when the step finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.stepFinished`).
    public var eventType: EventType { .stepFinished }

    // MARK: - Initialization

    /// Creates a new `StepFinishedEvent`.
    ///
    /// - Parameters:
    ///   - stepName: The name of the step that has finished
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        stepName: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.stepName = stepName
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension StepFinishedEvent: CustomStringConvertible {
    public var description: String {
        "StepFinishedEvent(stepName: \(stepName), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension StepFinishedEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        StepFinishedEvent {
            stepName: "\(stepName)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
