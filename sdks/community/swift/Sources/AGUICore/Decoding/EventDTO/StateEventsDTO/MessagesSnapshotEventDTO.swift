// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct MessagesSnapshotEventDTO {
    let messages: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> MessagesSnapshotEventDTO {
        // Parse the entire JSON to extract the messages field
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let messagesValue = jsonObject["messages"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.messages,
                DecodingError.Context(codingPath: [], debugDescription: "Missing messages field")
            )
        }

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert messages value to JSON data
        // Use JSONEncoder for primitives, JSONSerialization for collections
        let messagesData: Data
        if messagesValue is NSNull {
            // NSNull needs special handling - encode as null JSON
            messagesData = Data("null".utf8)
        } else if messagesValue is [Any] || messagesValue is [String: Any] {
            // Collections can use JSONSerialization
            messagesData = try JSONSerialization.data(withJSONObject: messagesValue, options: [])
        } else {
            // Primitives need JSONEncoder
            let encoder = JSONEncoder()
            messagesData = try encoder.encode(JSONPrimitiveWrapper(value: messagesValue))
        }

        return MessagesSnapshotEventDTO(messages: messagesData, timestamp: timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case messages
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> MessagesSnapshotEvent {
        MessagesSnapshotEvent(
            messages: messages,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
