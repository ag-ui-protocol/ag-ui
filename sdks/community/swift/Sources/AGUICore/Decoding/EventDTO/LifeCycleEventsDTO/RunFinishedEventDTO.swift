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

        // Decode outcome; unknown or missing values fall back to .completed for
        // forward-compatibility with future protocol versions.
        let outcome: RunFinishedOutcome
        if let raw = jsonObject["outcome"] as? String,
           let parsed = RunFinishedOutcome(rawValue: raw) {
            outcome = parsed
        } else {
            outcome = .completed
        }

        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        var resultData: Data?
        if let resultValue = jsonObject["result"], !(resultValue is NSNull) {
            resultData = try? JSONSerialization.data(withJSONObject: resultValue)
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
