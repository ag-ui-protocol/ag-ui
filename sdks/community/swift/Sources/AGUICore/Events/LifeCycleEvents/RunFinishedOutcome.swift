// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

/// Describes why an agent run finished.
///
/// Carried by `RunFinishedEvent` and decoded from the `"outcome"` field in the
/// AG-UI wire format. Unknown values from future protocol versions fall back to
/// `.completed`.
public enum RunFinishedOutcome: String, Equatable, Hashable, Sendable, Codable {

    /// The run completed normally with a result (or no result).
    case completed = "COMPLETED"

    /// The run was cancelled before it produced a final result.
    case cancelled = "CANCELLED"

    /// The run stopped because it reached the configured iteration ceiling.
    case maxIterationsReached = "MAX_ITERATIONS_REACHED"
}
