// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decodes AG-UI 1.0 media sources, accepting legacy URL/data fields for migration.
struct AudioInputContentDTO {
    let content: AudioInputContent

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> AudioInputContentDTO {
        let fields = try MediaInputContentDTO.decode(from: data, type: "audio", legacyHint: "format", decoder: decoder)
        return Self(content: AudioInputContent(source: fields.source, id: fields.id, metadata: fields.metadata))
    }

    func toDomain() -> AudioInputContent { content }
}
