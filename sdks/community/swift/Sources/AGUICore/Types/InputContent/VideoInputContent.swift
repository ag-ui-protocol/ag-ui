// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// A video part using the AG-UI 1.0 source representation.
public struct VideoInputContent: InputContent, Hashable, Sendable, MediaInputContent {
    public let type = "video"
    public let source: InputContentSource
    public let id: String?
    /// Optional metadata as raw JSON bytes (including scalar and array values).
    public let metadata: Data?

    /// Compatibility accessor for URL-backed content.
    public var url: String? { source.type == "url" ? source.value : nil }
    /// Compatibility accessor for inline content.
    public var data: String? { source.type == "data" ? source.value : nil }
    public var mimeType: String? { source.mimeType }

    public init(source: InputContentSource, id: String? = nil, metadata: Data? = nil) {
        self.source = source
        self.id = id
        self.metadata = metadata
    }

    /// Creates URL-backed content. Legacy hints are carried in metadata.
    public init(url: String, mimeType: String? = nil) {
        self.init(source: .url(value: url, mimeType: mimeType))
    }

    /// Creates inline content. If omitted, the MIME type defaults to application/octet-stream.
    /// Supply the actual MIME type whenever known.
    public init(data: String, mimeType: String? = nil) {
        self.init(source: .data(value: data, mimeType: mimeType ?? "application/octet-stream"))
    }
}
