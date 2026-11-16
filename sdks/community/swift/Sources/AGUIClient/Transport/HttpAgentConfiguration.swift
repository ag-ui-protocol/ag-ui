// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Configuration for HTTP agent client.
public struct HttpAgentConfiguration: Sendable {
    /// Base URL for the agent endpoint.
    public var baseURL: URL

    /// Timeout interval for requests in seconds.
    public var timeout: TimeInterval

    /// Retry policy for failed requests.
    public var retryPolicy: RetryPolicy

    /// Additional HTTP headers to include in requests.
    public var headers: [String: String]

    /// When `true`, enables verbose pipeline logging.
    ///
    /// Default: `false`
    public var debug: Bool

    /// Bearer token for authentication.
    ///
    /// When set, ``buildHeaders()`` includes `Authorization: Bearer <token>`.
    /// This property does **not** mutate ``headers`` directly — call
    /// ``buildHeaders()`` to get the merged header dictionary for requests.
    ///
    /// Default: `nil`
    public var bearerToken: String?

    /// API key value.
    ///
    /// When set, ``buildHeaders()`` includes the key under ``apiKeyHeader``.
    /// This property does **not** mutate ``headers`` directly — call
    /// ``buildHeaders()`` to get the merged header dictionary for requests.
    ///
    /// Default: `nil`
    public var apiKey: String?

    /// Header name used when adding the ``apiKey``.
    ///
    /// Default: `"X-API-Key"`
    public var apiKeyHeader: String

    // MARK: - Header builder

    /// Returns the final HTTP header dictionary, merging ``bearerToken`` and
    /// ``apiKey`` into ``headers``.
    ///
    /// Priority (highest → lowest):
    /// 1. Entries already in ``headers`` (override everything)
    /// 2. `bearerToken` → `Authorization: Bearer <token>`
    /// 3. `apiKey` → `<apiKeyHeader>: <key>`
    ///
    /// Header names are compared case-insensitively when applying this priority.
    ///
    /// - Returns: Merged header dictionary ready for request construction.
    public func buildHeaders() -> [String: String] {
        var result: [String: String] = [:]
        func setHeader(_ name: String, value: String) {
            if let existing = result.keys.first(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
                result.removeValue(forKey: existing)
            }
            result[name] = value
        }
        if let key = apiKey {
            setHeader(apiKeyHeader, value: sanitizeHeaderValue(key))
        }
        if let token = bearerToken {
            setHeader("Authorization", value: "Bearer \(sanitizeHeaderValue(token))")
        }
        for (k, v) in headers.sorted(by: { $0.key < $1.key }) {
            setHeader(k, value: sanitizeHeaderValue(v))
        }
        return result
    }

    /// Strips CR and LF characters from a header value to prevent CRLF injection.
    ///
    /// URLSession rejects headers containing `\r\n` on Apple platforms, but custom
    /// `HTTPClient` implementations may not. Sanitizing at the source protects all
    /// transport implementations uniformly.
    private func sanitizeHeaderValue(_ value: String) -> String {
        value.replacingOccurrences(of: "\r", with: "")
             .replacingOccurrences(of: "\n", with: "")
    }

    /// Retry policy options.
    public enum RetryPolicy: Sendable {
        /// No retry on failure.
        case none

        /// Fixed retry with maximum attempts and delay.
        case fixed(maxAttempts: Int, delay: TimeInterval)

        /// Exponential backoff retry.
        case exponentialBackoff(maxAttempts: Int, baseDelay: TimeInterval)
    }

    /// Creates a new HTTP agent configuration.
    ///
    /// - Parameters:
    ///   - baseURL: The base URL for the agent endpoint
    ///   - timeout: Request timeout in seconds (default: 120.0)
    ///   - retryPolicy: Retry policy for failures (default: .none)
    ///   - headers: Additional HTTP headers (default: empty)
    ///   - debug: Enable verbose pipeline logging (default: false)
    public init(
        baseURL: URL,
        timeout: TimeInterval = 120.0,
        retryPolicy: RetryPolicy = .none,
        headers: [String: String] = [:],
        debug: Bool = false
    ) {
        self.baseURL = baseURL
        self.timeout = timeout
        self.retryPolicy = retryPolicy
        self.headers = headers
        self.debug = debug
        bearerToken = nil
        apiKey = nil
        apiKeyHeader = "X-API-Key"
    }
}

public extension HttpAgentConfiguration {
    /// Creates a configuration with the specified base URL string.
    ///
    /// - Parameter baseURLString: The base URL string
    /// - Throws: `ClientError.invalidURL` if the URL string is invalid
    /// - Returns: A new configuration instance
    static func create(baseURLString: String) throws -> HttpAgentConfiguration {
        guard let url = URL(string: baseURLString) else {
            throw ClientError.invalidURL
        }
        return HttpAgentConfiguration(baseURL: url)
    }
}
