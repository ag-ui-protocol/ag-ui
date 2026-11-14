// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

struct MediaInputContentDTO {
    let source: InputContentSource
    let id: String?
    let metadata: Data?

    static func decode(from data: Data, type: String, legacyHint: String?, decoder: JSONDecoder) throws -> Self {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              object["type"] == nil || object["type"] as? String == type else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Expected \(type) content object"))
        }
        let source: InputContentSource
        if let value = object["source"] {
            source = try decoder.decode(InputContentSource.self, from: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed))
        } else if let url = object["url"] as? String {
            source = .url(value: url, mimeType: object["mimeType"] as? String)
        } else if let bytes = object["data"] as? String {
            source = .data(value: bytes, mimeType: object["mimeType"] as? String ?? "application/octet-stream")
        } else {
            throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "Media content requires a source"))
        }
        var metadata: Data?
        if let value = object["metadata"], !(value is NSNull) {
            metadata = try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
        } else if let hint = legacyHint, let value = object[hint] as? String {
            metadata = try JSONSerialization.data(withJSONObject: [hint: value], options: .sortedKeys)
        }
        return Self(source: source, id: object["id"] as? String, metadata: metadata)
    }
}
