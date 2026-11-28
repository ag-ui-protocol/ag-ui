// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decodes AG-UI 1.0 media sources, accepting legacy URL/data fields for migration.
struct ImageInputContentDTO {
    let content: ImageInputContent

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> ImageInputContentDTO {
        let fields = try MediaInputContentDTO.decode(from: data, type: "image", legacyHint: "detail", decoder: decoder)
        return Self(content: ImageInputContent(source: fields.source, id: fields.id, metadata: fields.metadata))
    }

    func toDomain() -> ImageInputContent { content }
}
