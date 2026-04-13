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

/// Data Transfer Object for ToolMessage decoding.
struct ToolMessageDTO {
    let id: String
    let toolCallId: String
    let content: String?
    let name: String?
    let error: String?

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ToolMessageDTO {
        guard let jsonObject = try JSONSerialization.jsonObject(with: data, options: []) as? [String: Any] else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: [], debugDescription: "Expected JSON object at root")
            )
        }

        // Validate role
        let role = try MessageDecodingHelpers.extractRole(from: jsonObject)
        try MessageDecodingHelpers.validateRole(role, expected: .tool)

        // Extract required fields
        let id = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "id")
        let toolCallId = try MessageDecodingHelpers.extractRequiredString(from: jsonObject, key: "toolCallId")

        // Extract optional fields
        let content = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "content")
        let name = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "name")
        let error = MessageDecodingHelpers.extractOptionalString(from: jsonObject, key: "error")

        return ToolMessageDTO(id: id, toolCallId: toolCallId, content: content, name: name, error: error)
    }

    func toDomain() -> ToolMessage {
        ToolMessage(id: id, content: content ?? "", toolCallId: toolCallId, name: name, error: error)
    }
}
