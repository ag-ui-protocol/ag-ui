// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Where a media part's bytes come from in AG-UI 1.0.
public enum InputContentSource: Hashable, Sendable, Codable {
    /// Inline base64 bytes. Their MIME type is required by the protocol.
    case data(value: String, mimeType: String)
    /// A resource to fetch. Its MIME type may be supplied by the response.
    case url(value: String, mimeType: String? = nil)
    /// An opaque provider-issued handle. Consumers must not fetch or parse it.
    case file(value: String, provider: String? = nil, mimeType: String? = nil)

    public var type: String {
        switch self {
        case .data: return "data"
        case .url: return "url"
        case .file: return "file"
        }
    }

    public var value: String {
        switch self {
        case .data(let value, _), .url(let value, _), .file(let value, _, _): return value
        }
    }

    public var mimeType: String? {
        switch self {
        case .data(_, let mimeType): return mimeType
        case .url(_, let mimeType), .file(_, _, let mimeType): return mimeType
        }
    }

    private enum CodingKeys: String, CodingKey { case type, value, mimeType, provider }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        let value = try container.decode(String.self, forKey: .value)
        switch type {
        case "data": self = .data(value: value, mimeType: try container.decode(String.self, forKey: .mimeType))
        case "url": self = .url(value: value, mimeType: try container.decodeIfPresent(String.self, forKey: .mimeType))
        case "file": self = .file(value: value,
                                  provider: try container.decodeIfPresent(String.self, forKey: .provider),
                                  mimeType: try container.decodeIfPresent(String.self, forKey: .mimeType))
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown media source type: \(type)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(value, forKey: .value)
        try container.encodeIfPresent(mimeType, forKey: .mimeType)
        if case .file(_, let provider, _) = self {
            try container.encodeIfPresent(provider, forKey: .provider)
        }
    }

    var wireObject: [String: Any] {
        var result: [String: Any] = ["type": type, "value": value]
        result["mimeType"] = mimeType
        if case .file(_, let provider, _) = self { result["provider"] = provider }
        return result
    }
}

/// Shared wire representation for concrete media parts.
protocol MediaInputContent: InputContent {
    var source: InputContentSource { get }
    var id: String? { get }
    var metadata: Data? { get }
}

extension MediaInputContent {
    var wireObject: [String: Any] {
        get throws {
            var result: [String: Any] = ["type": type, "source": source.wireObject]
            result["id"] = id
            if let metadata {
                let value = try JSONSerialization.jsonObject(with: metadata, options: .fragmentsAllowed)
                // Optional null metadata is omitted, as in other SDK wire encoders.
                if !(value is NSNull) { result["metadata"] = value }
            }
            return result
        }
    }
}
