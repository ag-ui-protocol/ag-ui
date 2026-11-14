// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A audio part using the AG-UI 1.0 source representation.
public struct AudioInputContent: InputContent, Hashable, Sendable, MediaInputContent {
    public let type = "audio"
    public let source: InputContentSource
    public let id: String?
    /// Optional metadata as raw JSON bytes (including scalar and array values).
    public let metadata: Data?

    /// Compatibility accessor for URL-backed content.
    public var url: String? { source.type == "url" ? source.value : nil }
    /// Compatibility accessor for inline content.
    public var data: String? { source.type == "data" ? source.value : nil }
    public var mimeType: String? { source.mimeType }

    /// Legacy hint, carried in metadata on the 1.0 wire.
    public var format: String? {
        guard let metadata,
              let object = try? JSONSerialization.jsonObject(with: metadata) as? [String: Any] else { return nil }
        return object["format"] as? String
    }

    public init(source: InputContentSource, id: String? = nil, metadata: Data? = nil) {
        self.source = source
        self.id = id
        self.metadata = metadata
    }

    /// Creates URL-backed content. Legacy hints are carried in metadata.
    public init(url: String, format: String? = nil, mimeType: String? = nil) {
        let metadata = format.flatMap { try? JSONSerialization.data(withJSONObject: ["format": $0], options: .sortedKeys) }
        self.init(source: .url(value: url, mimeType: mimeType), metadata: metadata)
    }

    /// Creates inline content. If omitted, the MIME type defaults to application/octet-stream.
    /// Supply the actual MIME type whenever known.
    public init(data: String, format: String? = nil, mimeType: String? = nil) {
        let metadata = format.flatMap { try? JSONSerialization.data(withJSONObject: ["format": $0], options: .sortedKeys) }
        self.init(source: .data(value: data, mimeType: mimeType ?? "application/octet-stream"), metadata: metadata)
    }
}
