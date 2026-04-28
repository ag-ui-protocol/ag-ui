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

/// Event indicating that an agent run has encountered an error.
///
/// This event is emitted when an agent run fails due to an unrecoverable error.
/// It provides error details and optional error codes for debugging and handling.
///
/// - SeeAlso: `RunStartedEvent`, `RunFinishedEvent`
public struct RunErrorEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the conversation thread.
    public let threadId: String

    /// The unique identifier for the failed run.
    public let runId: String

    /// Error information.
    public let error: ErrorInfo

    /// Optional timestamp when the error occurred.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.runError`).
    public var eventType: EventType { .runError }

    // MARK: - Nested Types

    /// Error information structure.
    public struct ErrorInfo: Codable, Equatable, Hashable, Sendable {
        /// Error code (e.g., "TOOL_EXECUTION_FAILED", "TIMEOUT")
        public let code: String

        /// Human-readable error message
        public let message: String

        /// Optional additional error details as JSON
        public let details: [String: String]?

        public init(code: String, message: String, details: [String: String]? = nil) {
            self.code = code
            self.message = message
            self.details = details
        }
    }

    // MARK: - Initialization

    /// Creates a new `RunErrorEvent`.
    ///
    /// - Parameters:
    ///   - threadId: The conversation thread identifier
    ///   - runId: The unique run identifier
    ///   - error: Error information
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        threadId: String,
        runId: String,
        error: ErrorInfo,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.threadId = threadId
        self.runId = runId
        self.error = error
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible

extension RunErrorEvent: CustomStringConvertible {
    public var description: String {
        "RunErrorEvent(threadId: \(threadId), runId: \(runId), " +
        "error: \(error.code), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension RunErrorEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        RunErrorEvent {
            threadId: "\(threadId)"
            runId: "\(runId)"
            error: \(error.code)
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
