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

struct ActivityDeltaEventDTO {
    let messageId: String
    let activityType: String
    let patch: Data
    let timestamp: Int64?

    static func decode(from data: Data, decoder: JSONDecoder) throws -> ActivityDeltaEventDTO {
        // Parse the entire JSON to extract fields
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        guard let messageId = jsonObject["messageId"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.messageId,
                DecodingError.Context(codingPath: [], debugDescription: "Missing messageId field")
            )
        }

        guard let activityType = jsonObject["activityType"] as? String else {
            throw DecodingError.keyNotFound(
                CodingKeys.activityType,
                DecodingError.Context(codingPath: [], debugDescription: "Missing activityType field")
            )
        }

        guard let patchValue = jsonObject["patch"] else {
            throw DecodingError.keyNotFound(
                CodingKeys.patch,
                DecodingError.Context(codingPath: [], debugDescription: "Missing patch field")
            )
        }

        // Extract timestamp using shared helper
        let timestamp = try EventDecodingHelpers.extractTimestamp(from: jsonObject)

        // Convert patch value to JSON data (must be an array)
        guard patchValue is [Any] else {
            throw DecodingError.typeMismatch(
                [Any].self,
                DecodingError.Context(codingPath: [], debugDescription: "Patch must be a JSON array")
            )
        }

        let patchData = try JSONSerialization.data(withJSONObject: patchValue, options: [])

        return ActivityDeltaEventDTO(
            messageId: messageId,
            activityType: activityType,
            patch: patchData,
            timestamp: timestamp
        )
    }

    enum CodingKeys: String, CodingKey {
        case messageId
        case activityType
        case patch
        case timestamp
    }

    func toDomain(rawEvent: Data? = nil) -> ActivityDeltaEvent {
        ActivityDeltaEvent(
            messageId: messageId,
            activityType: activityType,
            patch: patch,
            timestamp: timestamp,
            rawEvent: rawEvent
        )
    }
}
