// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Decodes AG-UI 1.0 media sources, accepting legacy URL/data fields for migration.
struct VideoInputContentDTO {
    let content: VideoInputContent

    static func decode(from data: Data, decoder: JSONDecoder = JSONDecoder()) throws -> VideoInputContentDTO {
        let fields = try MediaInputContentDTO.decode(from: data, type: "video", legacyHint: nil, decoder: decoder)
        return Self(content: VideoInputContent(source: fields.source, id: fields.id, metadata: fields.metadata))
    }

    func toDomain() -> VideoInputContent { content }
}
