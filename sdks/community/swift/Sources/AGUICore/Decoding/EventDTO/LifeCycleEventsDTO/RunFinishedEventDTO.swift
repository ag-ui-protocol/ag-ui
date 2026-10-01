// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct RunFinishedEventDTO {
    let threadId: String
    let runId: String
    let outcome: RunFinishedOutcome
    let result: Data?
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> RunFinishedEventDTO {
        guard let jsonObject = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        let threadId: String
        if let raw = jsonObject["threadId"] {
            guard let value = raw as? String else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.threadId], debugDescription: "Type mismatch for 'threadId': expected String")
                )
            }
            threadId = value
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.threadId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: threadId")
            )
        }

        let runId: String
        if let raw = jsonObject["runId"] {
            guard let value = raw as? String else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.runId], debugDescription: "Type mismatch for 'runId': expected String")
                )
            }
            runId = value
        } else {
            throw DecodingError.keyNotFound(
                CodingKeys.runId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing required field: runId")
            )
        }

        // Decode the AG-UI 1.0 outcome discriminated union: { "type": "success" | "cancelled" |
        // "interrupt", "interrupts"?: [...] }. Missing or unrecognised values fall back to
        // .success for forward compatibility with legacy producers and future protocol versions.
        let outcome: RunFinishedOutcome
        if let outcomeObject = jsonObject["outcome"] as? [String: Any],
           let typeRaw = outcomeObject["type"] as? String {
            switch typeRaw {
            case "success":
                outcome = .success
            case "cancelled":
                outcome = .cancelled
            case "interrupt":
                let interruptDicts = (outcomeObject["interrupts"] as? [[String: Any]]) ?? []
                let interrupts = interruptDicts.compactMap { try? Interrupt.decode(from: $0) }
                outcome = .interrupt(interrupts)
            default:
                outcome = .success
            }
        } else {
            outcome = .success
        }

        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        var resultData: Data?
        if let resultValue = jsonObject["result"], !(resultValue is NSNull) {
            if resultValue is [Any] || resultValue is [String: Any] {
                // Collections are valid top-level JSON objects for JSONSerialization.
                resultData = try? JSONSerialization.data(withJSONObject: resultValue, options: [])
            } else {
                // Scalar result (number, string, bool) — JSONSerialization.data(withJSONObject:)
                // raises an NSException (not a Swift error) for non-collection top-level values,
                // so try? does not protect against the crash. Use JSONPrimitiveWrapper + JSONEncoder
                // instead, matching how StateSnapshotEventDTO handles scalar state values.
                resultData = try? JSONEncoder().encode(JSONPrimitiveWrapper(value: resultValue))
            }
        }

        return RunFinishedEventDTO(threadId: threadId, runId: runId, outcome: outcome, result: resultData, timestamp: timestamp)
    }

    func toDomain(rawEvent: Data? = nil) -> RunFinishedEvent {
        RunFinishedEvent(threadId: threadId, runId: runId, outcome: outcome, result: result, timestamp: timestamp, rawEvent: rawEvent)
    }

    private enum CodingKeys: String, CodingKey {
        case threadId, runId, outcome, result, timestamp
    }
}
