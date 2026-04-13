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

struct CustomEventDTO {
    let customType: String
    let data: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> CustomEventDTO {
        // Parse the entire JSON to extract the customType and data fields
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // AG-UI protocol wire format uses "name" (not "customType")
        guard let customType = jsonObject["name"] as? String else {
            if jsonObject["name"] == nil {
                throw DecodingError.keyNotFound(
                    CodingKeys.customType,
                    DecodingError.Context(codingPath: [], debugDescription: "Missing key 'name' at root")
                )
            } else {
                throw DecodingError.typeMismatch(
                    String.self,
                    DecodingError.Context(codingPath: [CodingKeys.customType], debugDescription: "Expected String for name")
                )
            }
        }

        // AG-UI protocol wire format uses "value" (not "data"); value is optional
        let dataValue = jsonObject["value"]

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert value to JSON data; treat absent/null value as empty object {}
        let eventData: Data
        if let dataValue {
            if dataValue is NSNull {
                eventData = Data("null".utf8)
            } else if dataValue is [Any] || dataValue is [String: Any] {
                eventData = try JSONSerialization.data(withJSONObject: dataValue, options: [])
            } else {
                let encoder = JSONEncoder()
                eventData = try encoder.encode(JSONPrimitiveWrapper(value: dataValue))
            }
        } else {
            eventData = Data("{}".utf8)
        }

        return CustomEventDTO(customType: customType, data: eventData, timestamp: timestamp)
    }

    // Wire keys: "name" maps to customType, "value" maps to data
    enum CodingKeys: String, CodingKey {
        case customType = "name"
        case data = "value"
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> CustomEvent {
        CustomEvent(
            customType: customType,
            data: data,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}

// Helper type to encode primitive JSON values
private struct JSONPrimitiveWrapper: Encodable {
    let value: Any

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let int64 as Int64:
            try container.encode(int64)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case is NSNull:
            try container.encodeNil()
        default:
            throw EncodingError.invalidValue(value, EncodingError.Context(codingPath: [], debugDescription: "Unsupported primitive type"))
        }
    }
}
