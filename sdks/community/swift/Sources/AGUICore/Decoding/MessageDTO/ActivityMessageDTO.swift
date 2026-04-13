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

/// Data Transfer Object for ActivityMessage decoding.
struct ActivityMessageDTO {
    let id: String
    let activityType: String
    let activityContent: Data

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ActivityMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .activity)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")
        let activityType = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "activityType")

        // Extract activityContent as JSON object
        guard let activityContentValue = jsonObject["activityContent"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.activityContent,
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Missing activityContent field"
                )
            )
        }

        // Convert activityContent to Data
        let activityContent: Data
        if activityContentValue is NSNull {
            activityContent = Data("null".utf8)
        } else if activityContentValue is [Any] || activityContentValue is [String: Any] {
            activityContent = try JSONSerialization.data(withJSONObject: activityContentValue, options: [])
        } else {
            // Primitive value - wrap in encoder
            let encoder = JSONEncoder()
            activityContent = try encoder.encode(JSONPrimitiveWrapper(value: activityContentValue))
        }

        return ActivityMessageDTO(id: id, activityType: activityType, activityContent: activityContent)
    }

    func toDomain() -> ActivityMessage {
        ActivityMessage(id: id, activityType: activityType, activityContent: activityContent)
    }

    private enum CodingKeys: String, CodingKey {
        case activityContent
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
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: [],
                    debugDescription: "Unsupported primitive type"
                )
            )
        }
    }
}
