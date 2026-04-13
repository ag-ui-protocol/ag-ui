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

/// Data Transfer Object for DeveloperMessage decoding.
struct DeveloperMessageDTO {
    let id: String
    let content: String
    let name: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> DeveloperMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .developer)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")
        let content = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "content")

        // Extract optional fields
        let name = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "name")

        return DeveloperMessageDTO(id: id, content: content, name: name)
    }

    func toDomain() -> DeveloperMessage {
        DeveloperMessage(id: id, content: content, name: name)
    }
}
