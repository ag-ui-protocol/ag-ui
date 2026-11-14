import Foundation

/// Lifecycle notification for a delegated run.
public struct SubagentEvent: AGUIEvent, Sendable {
    public let eventType: EventType
    public let subagentRunId: String
    public let name: String?
    public let timestamp: Int64?
    public let rawEvent: Data?

    public init(eventType: EventType, subagentRunId: String, name: String?, timestamp: Int64?, rawEvent: Data?) {
        self.eventType = eventType
        self.subagentRunId = subagentRunId
        self.name = name
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}
