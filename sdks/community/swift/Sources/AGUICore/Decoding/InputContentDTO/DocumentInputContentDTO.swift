// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decodes AG-UI 1.0 media sources, accepting legacy URL/data fields for migration.
struct DocumentInputContentDTO {
    let content: DocumentInputContent

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> DocumentInputContentDTO {
        let fields = try MediaInputContentDTO.decode(from: data, type: "document", legacyHint: "title", decoder: decoder)
        return Self(content: DocumentInputContent(source: fields.source, id: fields.id, metadata: fields.metadata))
    }

    func toDomain() -> DocumentInputContent { content }
}
