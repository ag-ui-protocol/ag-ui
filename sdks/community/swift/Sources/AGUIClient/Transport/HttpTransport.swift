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

import AGUICore
import Foundation

/// Low-level HTTP transport for AG-UI agent communication.
///
/// `HttpTransport` handles HTTP communication with AG-UI agents using
/// dependency injection for testability and flexibility. It accepts any
/// `HTTPClient` implementation, defaulting to `URLSessionHTTPClient`.
///
/// ## Example
///
/// ```swift
/// // Default usage with URLSession
/// let config = HttpAgentConfiguration(baseURL: agentURL)
/// let transport = HttpTransport(configuration: config)
///
/// // With custom HTTP client (e.g., for testing)
/// let mockClient = MockHTTPClient()
/// let transport = HttpTransport(
///     configuration: config,
///     httpClient: mockClient
/// )
///
/// // Execute request
/// let bytes = try await transport.execute(endpoint: "/run", input: input)
/// ```
public actor HttpTransport {
    private let httpClient: any HTTPClient
    private let configuration: HttpAgentConfiguration

    /// Creates a new HTTP transport with dependency injection.
    ///
    /// - Parameters:
    ///   - configuration: HTTP agent configuration
    ///   - httpClient: HTTP client implementation (optional)
    ///
    /// If no HTTP client is provided, creates a default `URLSessionHTTPClient`
    /// configured according to the provided configuration.
    ///
    /// ## Default Client Configuration
    ///
    /// When using the default client, URLSession is configured with:
    /// - Request timeout from configuration
    /// - Resource timeout from configuration
    /// - Custom headers from configuration
    /// - User-Agent header set to "AGUISwift/1.0"
    ///
    /// ## Dependency Injection
    ///
    /// For testing or custom networking, inject a custom HTTPClient:
    ///
    /// ```swift
    /// let mockClient = MockHTTPClient()
    /// let transport = HttpTransport(
    ///     configuration: config,
    ///     httpClient: mockClient
    /// )
    /// ```
    public init(
        configuration: HttpAgentConfiguration,
        httpClient: (any HTTPClient)? = nil
    ) {
        self.configuration = configuration

        if let httpClient = httpClient {
            self.httpClient = httpClient
        } else {
            // Create default URLSession-based client
            let sessionConfig = URLSessionConfiguration.default
            // timeoutIntervalForRequest: max idle time between consecutive bytes (per-chunk).
            // For AI streaming, the inference step can take 30-120 s before the first
            // token arrives; use at least 5 minutes so we don't cut off mid-inference.
            // timeoutIntervalForResource: total wall-clock cap for the full stream.
            // Cap at 1 hour so even long agent runs complete without being killed.
            sessionConfig.timeoutIntervalForRequest = max(configuration.timeout, 300)
            sessionConfig.timeoutIntervalForResource = max(configuration.timeout, 3600)

            // Set additional headers
            var headers = configuration.headers
            headers["User-Agent"] = "AGUISwift/1.0"
            sessionConfig.httpAdditionalHeaders = headers

            let session = URLSession(configuration: sessionConfig)
            self.httpClient = URLSessionHTTPClient(session: session)
        }
    }

    /// Executes an HTTP request and returns streaming bytes.
    ///
    /// - Parameters:
    ///   - endpoint: The endpoint path (e.g., "/run")
    ///   - input: The run agent input to send
    /// - Returns: An async sequence of bytes from the server
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Request Format
    ///
    /// The request is constructed as:
    /// - Method: POST
    /// - URL: `baseURL` + `endpoint`
    /// - Headers:
    ///   - Content-Type: application/json
    ///   - Accept: text/event-stream
    /// - Body: JSON-encoded `RunAgentInput`
    ///
    /// ## Response Validation
    ///
    /// Validates the HTTP response:
    /// - Status code must be 200-299
    /// - Response must be HTTPURLResponse
    ///
    /// ## Error Handling
    ///
    /// Throws `ClientError` for:
    /// - Encoding failures → `.decodingError`
    /// - Non-2xx status codes → `.httpError(statusCode:)`
    /// - Invalid responses → `.invalidResponse`
    /// - Network errors → `.networkError`, `.timeout`, `.cancelled`
    public func execute(
        endpoint: String,
        input: RunAgentInput
    ) async throws -> URLSession.AsyncBytes {
        // Construct URL
        let url = configuration.baseURL.appendingPathComponent(endpoint)

        // Create request
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

        // Encode RunAgentInput to JSON
        let encoder = JSONEncoder()
        do {
            request.httpBody = try encoder.encode(input)
        } catch {
            throw ClientError.decodingError(error)
        }

        // Execute request via injected HTTP client
        let response = try await httpClient.execute(request)

        // Validate HTTP status code
        guard (200...299).contains(response.statusCode) else {
            throw ClientError.httpError(statusCode: response.statusCode)
        }

        return response.bytes
    }
}
