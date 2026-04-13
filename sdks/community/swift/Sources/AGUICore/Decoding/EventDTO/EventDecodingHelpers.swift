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

/// Helper utilities for decoding event DTOs.
///
/// This enum provides shared decoding logic to reduce code duplication across event DTOs
/// and ensure consistent error handling.
enum EventDecodingHelpers {

    /// Extracts and validates a timestamp field from a JSON object.
    ///
    /// This method handles various timestamp representations:
    /// - Missing field: returns `nil`
    /// - NSNull value: returns `nil`
    /// - Int64 value: returns the value
    /// - Int value: converts to Int64 and returns
    /// - Other types: throws a type mismatch error
    ///
    /// - Parameter jsonObject: The JSON dictionary containing the timestamp field
    /// - Returns: The timestamp as Int64, or nil if not present or null
    /// - Throws: `DecodingError.typeMismatch` if timestamp has an invalid type
    static func extractTimestamp(from jsonObject: [String: Any]) throws -> Int64? {
        guard let timestampValue = jsonObject["timestamp"] else {
            return nil
        }

        if timestampValue is NSNull {
            return nil
        } else if let timestampValue = timestampValue as? Int64 {
            return timestampValue
        } else if let timestampValue = timestampValue as? Int {
            return Int64(timestampValue)
        } else {
            throw DecodingError.typeMismatch(
                Int64.self,
                DecodingError.Context(
                    codingPath: [CodingKeys.timestamp],
                    debugDescription: "Expected Int64 for timestamp, got \(type(of: timestampValue))"
                )
            )
        }
    }

    /// Helper CodingKey for constructing error contexts.
    private enum CodingKeys: String, CodingKey {
        case timestamp
    }
}
