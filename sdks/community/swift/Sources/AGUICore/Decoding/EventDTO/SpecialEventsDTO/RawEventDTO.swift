// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct RawEventDTO {
    let data: Data
    let source: String?
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> RawEventDTO {
        // Parse the entire JSON to extract the event field
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Protocol wire field is "event" (not "data") per AG-UI spec
        guard let eventValue = jsonObject["event"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.event,
                DecodingError.Context(codingPath: [], debugDescription: "Missing event field")
            )
        }

        // Extract optional source field
        let source = jsonObject["source"] as? String

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert event value to JSON data
        // Use JSONEncoder for primitives, JSONSerialization for collections
        let eventData: Data
        eventData = try anyToJSONData(eventValue)

        return RawEventDTO(data: eventData, source: source, timestamp: timestamp)
    }

    enum CodingKeys: String, CodingKey {
        case event
        case source
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> RawEvent {
        RawEvent(
            data: data,
            source: source,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
