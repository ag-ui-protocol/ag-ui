// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Event indicating that an agent run has completed successfully.
///
/// This event is emitted when an agent has finished processing a run request
/// and has generated all output. It signals the end of the execution lifecycle.
///
/// - SeeAlso: `RunStartedEvent`, `RunErroredEvent`
public struct RunFinishedEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The identifier for the conversation thread.
    public let threadId: String

    /// The unique identifier for the completed run.
    public let runId: String

    /// Why the run finished.
    ///
    /// Decoded from the `"outcome"` field in the AG-UI wire format.
    /// Defaults to `.completed` when the field is absent or unrecognised.
    public let outcome: RunFinishedOutcome

    /// Optional run result as raw JSON.
    ///
    /// Corresponds to `result: z.any().optional()` in the AG-UI protocol.
    /// Stored as opaque `Data` because the result schema is arbitrary JSON.
    public let result: Data?

    /// Optional timestamp when the run finished.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.runFinished`).
    public var eventType: EventType { .runFinished }

    // MARK: - Initialization

    /// Creates a new `RunFinishedEvent`.
    ///
    /// - Parameters:
    ///   - threadId: The conversation thread identifier
    ///   - runId: The unique run identifier
    ///   - outcome: Why the run finished (defaults to `.completed`)
    ///   - result: Optional run result as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        threadId: String,
        runId: String,
        outcome: RunFinishedOutcome = .completed,
        result: Data? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.threadId = threadId
        self.runId = runId
        self.outcome = outcome
        self.result = result
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible

extension RunFinishedEvent: CustomStringConvertible {

    public var description: String {
        "RunFinishedEvent(threadId: \(threadId), runId: \(runId), outcome: \(outcome.rawValue), timestamp: \(timestamp?.description ?? "nil"))"
    }
}
