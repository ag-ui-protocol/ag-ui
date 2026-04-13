/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
    /// When set, automatically adds `Authorization: Bearer <token>` to ``headers``.
    /// Setting to `nil` does not remove a manually added `Authorization` header.
    ///
    /// Default: `nil`
    public var bearerToken: String? {
        didSet {
            if let token = bearerToken {
                headers["Authorization"] = "Bearer \(token)"
            }
        }
    }

    /// API key value.
    ///
    /// When set, automatically adds the key to ``headers`` under ``apiKeyHeader``.
    /// Setting to `nil` does not remove a manually added header.
    ///
    /// Default: `nil`
    public var apiKey: String? {
        didSet {
            if let key = apiKey {
                headers[apiKeyHeader] = key
            }
        }
    }

    /// Header name used when adding the ``apiKey``.
    ///
    /// Default: `"X-API-Key"`
    public var apiKeyHeader: String

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
        self.bearerToken = nil
        self.apiKey = nil
        self.apiKeyHeader = "X-API-Key"
    }
}

extension HttpAgentConfiguration {
    /// Creates a configuration with the specified base URL string.
    ///
    /// - Parameter baseURLString: The base URL string
    /// - Throws: `ClientError.invalidURL` if the URL string is invalid
    /// - Returns: A new configuration instance
    public static func create(baseURLString: String) throws -> HttpAgentConfiguration {
        guard let url = URL(string: baseURLString) else {
            throw ClientError.invalidURL
        }
        return HttpAgentConfiguration(baseURL: url)
    }
}
