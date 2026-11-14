// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct ToolCallResultEventDTO {
    let messageId: String
    let toolCallId: String
    let content: String
    let role: String?
    let timestamp: Int64?

    private struct Header: Decodable {
        let messageId: String
        let toolCallId: String
        let role: String?
        let timestamp: Int64?
    }

    static func decode(from data: Data, decoder: JSONDecoder) throws -> Self {
        let header = try decoder.decode(Header.self, from: data)
        guard let value = try EventJSONField.value("content", from: data) else {
            throw DecodingError.keyNotFound(
                CodingKeys.content,
                .init(codingPath: [], debugDescription: "Missing content field")
            )
        }
        let content: String
        switch value {
        case .string(let text): content = text
        case .array: content = String(decoding: try value.encoded(), as: UTF8.self)
        default:
            throw DecodingError.typeMismatch(
                [AGUIJSON].self,
                .init(codingPath: [CodingKeys.content], debugDescription: "Expected string or content parts array")
            )
        }
        return Self(messageId: header.messageId, toolCallId: header.toolCallId,
                    content: content, role: header.role, timestamp: header.timestamp)
    }

    private enum CodingKeys: String, CodingKey { case content }

    func toDomain(rawEvent: Data? = nil) -> ToolCallResultEvent {
        ToolCallResultEvent(messageId: messageId, toolCallId: toolCallId,
                            content: content, role: role, timestamp: timestamp, rawEvent: rawEvent)
    }
}
