// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

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

        // Extract content as JSON object (wire format key is "content")
        guard let activityContent = try EventJSONField.data("content", from: data) else {
            throw DecodingError.keyNotFound(
                CodingKeys.content,
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Missing content field"
                )
            )
        }

        return ActivityMessageDTO(id: id, activityType: activityType, activityContent: activityContent)
    }

    func toDomain() -> ActivityMessage {
        ActivityMessage(id: id, activityType: activityType, content: activityContent)
    }

    private enum CodingKeys: String, CodingKey {
        case content
    }
}
