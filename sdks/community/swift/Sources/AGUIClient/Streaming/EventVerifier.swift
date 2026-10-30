// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - AGUIProtocolError

/// An error thrown when the AG-UI protocol event sequence is violated.
public struct AGUIProtocolError: Error, Sendable, CustomStringConvertible {
    /// A human-readable description of the protocol violation.
    public let message: String

    public init(message: String) {
        self.message = message
    }
    public var description: String { message }
}

// MARK: - EventVerifier

/// Internal state machine that validates AG-UI protocol event sequences.
///
/// All access to this class is serialized within a single Task, so no
/// actor isolation is needed.
private final class EventVerifier {
    var firstEventReceived: Bool = false
    var runStarted: Bool = false
    var runFinished: Bool = false
    var runError: Bool = false
    var activeMessages: [String: Bool] = [:]
    var activeToolCalls: [String: Bool] = [:]
    var activeSteps: [String: Bool] = [:]
    var activeReasoningMessages: Set<String> = []
    var activeReasoningSpans: Set<String> = []
    var activeSubagents: Set<String> = []
    var activeAttribution: [String: String] = [:]

    let debug: Bool

    init(debug: Bool) {
        self.debug = debug
    }

    func verify(_ event: any AGUIEvent) throws {
        let type = event.eventType.rawValue

        // Handle RUN_STARTED as a special case first — it resets state for multi-run support
        if let _ = event as? RunStartedEvent {
            if runStarted && !runFinished && !runError {
                throw AGUIProtocolError(message: "Cannot send 'RUN_STARTED' while a run is still active")
            }
            // A terminal RUN_ERROR may leave open event scopes. A subsequent
            // RUN_STARTED begins a fresh run regardless of how the prior one ended.
            activeMessages.removeAll()
            activeToolCalls.removeAll()
            activeSteps.removeAll()
            activeReasoningMessages.removeAll()
            activeReasoningSpans.removeAll()
            activeSubagents.removeAll()
            activeAttribution.removeAll()
            runFinished = false
            runError = false
            runStarted = true
            firstEventReceived = true
            return
        }

        // Handle RUN_ERROR as a special case — allowed as first event
        if let _ = event as? RunErrorEvent {
            runError = true
            firstEventReceived = true
            return
        }

        // First event must be RUN_STARTED or RUN_ERROR
        if !firstEventReceived {
            throw AGUIProtocolError(message: "First event must be 'RUN_STARTED'")
        }

        // After RUN_FINISHED (and no new RUN_STARTED has arrived), no events
        if runFinished {
            throw AGUIProtocolError(
                message: "The run has already finished with 'RUN_FINISHED': \(type)"
            )
        }

        // Validate each event type
        switch event {
        case let e as TextMessageStartEvent:
            let id = e.messageId
            recordAttribution(event, key: "message:\(id)")
            if activeMessages[id] == true {
                throw AGUIProtocolError(
                    message: "A text message with ID '\(id)' is already in progress"
                )
            }
            activeMessages[id] = true

        case let e as TextMessageContentEvent:
            let id = e.messageId
            try checkAttribution(event, key: "message:\(id)")
            guard activeMessages[id] == true else {
                throw AGUIProtocolError(
                    message: "No active text message found with ID '\(id)'"
                )
            }

        case let e as TextMessageEndEvent:
            let id = e.messageId
            guard activeMessages[id] == true else {
                throw AGUIProtocolError(
                    message: "No active text message found with ID '\(id)'"
                )
            }
            activeMessages.removeValue(forKey: id)

        case let e as ToolCallStartEvent:
            let id = e.toolCallId
            recordAttribution(event, key: "tool:\(id)")
            if activeToolCalls[id] == true {
                throw AGUIProtocolError(
                    message: "A tool call with ID '\(id)' is already in progress"
                )
            }
            activeToolCalls[id] = true

        case let e as ToolCallArgsEvent:
            let id = e.toolCallId
            try checkAttribution(event, key: "tool:\(id)")
            guard activeToolCalls[id] == true else {
                throw AGUIProtocolError(
                    message: "No active tool call found with ID '\(id)'"
                )
            }

        case let e as ToolCallEndEvent:
            let id = e.toolCallId
            try checkAttribution(event, key: "tool:\(id)")
            guard activeToolCalls[id] == true else {
                throw AGUIProtocolError(
                    message: "No active tool call found with ID '\(id)'"
                )
            }
            activeToolCalls.removeValue(forKey: id)

        case let e as StepStartedEvent:
            activeSteps[e.stepName] = true

        case let e as StepFinishedEvent:
            let name = e.stepName
            guard activeSteps[name] == true else {
                throw AGUIProtocolError(
                    message: "Cannot send 'STEP_FINISHED' for step '\(name)' that was not started"
                )
            }
            activeSteps.removeValue(forKey: name)

        case let e as ReasoningStartEvent:
            guard activeReasoningSpans.insert(e.messageId).inserted else {
                throw AGUIProtocolError(message: "Reasoning span '\(e.messageId)' is already open")
            }

        case let e as ReasoningEndEvent:
            guard activeReasoningSpans.remove(e.messageId) != nil else {
                throw AGUIProtocolError(message: "No active reasoning span found with ID '\(e.messageId)'")
            }

        case let e as ReasoningMessageStartEvent:
            guard e.role == "reasoning" else { throw AGUIProtocolError(message: #"REASONING_MESSAGE_START expected \"reasoning\" role"#) }
            guard activeReasoningMessages.insert(e.messageId).inserted else {
                throw AGUIProtocolError(message: "Reasoning message '\(e.messageId)' is already open")
            }

        case let e as ReasoningMessageContentEvent:
            guard activeReasoningMessages.contains(e.messageId) else {
                throw AGUIProtocolError(message: "No active reasoning message found with ID '\(e.messageId)'")
            }

        case let e as ReasoningMessageEndEvent:
            guard activeReasoningMessages.contains(e.messageId) else {
                throw AGUIProtocolError(message: "No active reasoning message found with ID '\(e.messageId)'")
            }
            activeReasoningMessages.remove(e.messageId)

        case let e as SubagentEvent:
            switch e.eventType {
            case .subagentStarted:
                guard let name = e.name, !name.isEmpty else { throw AGUIProtocolError(message: "SUBAGENT_STARTED requires name") }
                activeSubagents.insert(e.subagentRunId)
            case .subagentFinished, .subagentError:
                guard activeSubagents.remove(e.subagentRunId) != nil else {
                    throw AGUIProtocolError(message: "Subagent \(e.subagentRunId) was not started")
                }
            default: break
            }

        case is RunFinishedEvent:
            if !activeMessages.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while text messages are still active"
                )
            }
            if !activeToolCalls.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while tool calls are still active"
                )
            }
            if !activeSteps.isEmpty {
                throw AGUIProtocolError(
                    message: "Cannot send 'RUN_FINISHED' while steps are still active"
                )
            }
            if let id = activeSubagents.first {
                throw AGUIProtocolError(message: "Cannot send 'RUN_FINISHED' while subagent \(id) is active")
            }
            if let id = activeReasoningSpans.first {
                throw AGUIProtocolError(message: "Cannot send 'RUN_FINISHED' while reasoning span \(id) is active")
            }
            if let id = activeReasoningMessages.first {
                throw AGUIProtocolError(message: "Cannot send 'RUN_FINISHED' while reasoning message \(id) is active")
            }
            runFinished = true

        default:
            break
        }

        if debug {
            print("[EventVerifier] Verified: \(type)")
        }
    }

    private func attribution(_ event: any AGUIEvent) -> String? {
        guard let data = event.rawEvent,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        return object["subagentRunId"] as? String
    }

    private func recordAttribution(_ event: any AGUIEvent, key: String) {
        if let id = attribution(event) { activeAttribution[key] = id }
    }

    private func checkAttribution(_ event: any AGUIEvent, key: String) throws {
        if let id = attribution(event), let opened = activeAttribution[key], id != opened {
            throw AGUIProtocolError(message: "subagentRunId \(id) does not match opener \(opened)")
        }
    }
}

// MARK: - AsyncSequence Extension

extension AsyncSequence where Element == any AGUIEvent {
    /// Validates that the event stream conforms to the AG-UI protocol state machine.
    ///
    /// Events are passed through unchanged if they are valid. If a protocol violation
    /// is detected, the stream throws an `AGUIProtocolError` and terminates.
    ///
    /// ## Example
    ///
    /// ```swift
    /// let verified = eventStream.verifyEvents()
    /// for try await event in verified {
    ///     // Only valid events reach here
    /// }
    /// ```
    ///
    /// - Parameter debug: When `true`, logs each verified event to stdout.
    /// - Returns: A throwing stream of verified events.
    public func verifyEvents(debug: Bool = false) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let verifier = EventVerifier(debug: debug)
                do {
                    for try await event in self {
                        try verifier.verify(event)
                        continuation.yield(event)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
