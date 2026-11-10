// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// URLSession-based HTTP client implementation.
///
/// `URLSessionHTTPClient` is the default HTTP client that uses Apple's
/// URLSession for networking. It supports full URLSession configuration
/// and can be injected with a custom session for testing.
///
/// ## Example
///
/// ```swift
/// // Default usage
/// let client = URLSessionHTTPClient.create()
///
/// // Custom configuration
/// let config = URLSessionConfiguration.default
/// config.timeoutIntervalForRequest = 30
/// let session = URLSession(configuration: config)
/// let client = URLSessionHTTPClient(session: session)
///
/// // Execute request
/// let request = URLRequest(url: url)
/// let response = try await client.execute(request)
/// ```
public actor URLSessionHTTPClient: HTTPClient {
    private let session: URLSession
    private let shouldInvalidateSession: Bool

    /// Creates a new URLSession HTTP client with the specified session.
    ///
    /// This is the primary initializer that accepts a URLSession instance,
    /// enabling full control over session configuration and injection of
    /// mock sessions for testing.
    ///
    /// The session remains owned by the caller. Releasing this client does not
    /// invalidate it; the caller is responsible for its lifecycle.
    ///
    /// - Parameter session: The URLSession to use for requests
    ///
    /// ## Example
    ///
    /// ```swift
    /// let config = URLSessionConfiguration.default
    /// config.timeoutIntervalForRequest = 60
    /// let session = URLSession(configuration: config)
    /// let client = URLSessionHTTPClient(session: session)
    /// ```
    public init(session: URLSession) {
        self.init(session: session, shouldInvalidateSession: false)
    }

    /// Specifies whether this client is responsible for invalidating the session.
    init(session: URLSession, shouldInvalidateSession: Bool) {
        self.session = session
        self.shouldInvalidateSession = shouldInvalidateSession
    }

    deinit {
        if shouldInvalidateSession {
            // Release owned resources without affecting caller-owned sessions.
            // invalidateAndCancel() is synchronous and safe to call from deinit.
            session.invalidateAndCancel()
        }
    }

    /// Creates a new URLSession HTTP client with the specified configuration.
    ///
    /// This factory method provides a convenient way to create a client
    /// with custom URLSession configuration. The client owns the new session
    /// and invalidates it when released, after any active byte producer ends.
    ///
    /// - Parameter configuration: URLSession configuration (default: .default)
    /// - Returns: A new URLSession HTTP client
    ///
    /// ## Example
    ///
    /// ```swift
    /// let config = URLSessionConfiguration.ephemeral
    /// config.timeoutIntervalForRequest = 30
    /// let client = URLSessionHTTPClient.create(configuration: config)
    /// ```
    public static func create(
        configuration: URLSessionConfiguration = .default
    ) -> URLSessionHTTPClient {
        let session = URLSession(configuration: configuration)
        return URLSessionHTTPClient(session: session, shouldInvalidateSession: true)
    }

    /// Executes an HTTP request using URLSession.
    ///
    /// - Parameter request: The URL request to execute
    /// - Returns: An HTTP response containing streaming bytes and metadata
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Error Mapping
    ///
    /// URLErrors, including those raised while streaming, are mapped to ClientError:
    /// - `.timedOut` → `.timeout`
    /// - `.cancelled` → `.cancelled`
    /// - Other errors → `.networkError`
    public func execute(_ request: URLRequest) async throws -> HTTPResponse {
        let (bytes, response): (URLSession.AsyncBytes, URLResponse)

        do {
            (bytes, response) = try await session.bytes(for: request)
        } catch let error as URLError {
            throw Self.mapURLError(error)
        } catch {
            throw ClientError.networkError(error)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw ClientError.invalidResponse
        }

        // Bridge URLSession.AsyncBytes → AsyncThrowingStream<UInt8, Error> so that
        // HTTPResponse is decoupled from URLSession and can be mocked in tests.
        let stream = AsyncThrowingStream<UInt8, Error> { continuation in
            // Keep the client (and its session) alive until the byte producer
            // completes or is cancelled. An HttpAgent may be released as soon
            // as it returns its EventStream to the caller.
            let task = Task { [owner = self] in
                defer { withExtendedLifetime(owner) {} }
                do {
                    for try await byte in bytes {
                        continuation.yield(byte)
                    }
                    continuation.finish()
                } catch let error as URLError {
                    // Map mid-stream failures so callers (and retry) see ClientError.
                    continuation.finish(throwing: Self.mapURLError(error))
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }

        return HTTPResponse(bytes: stream, httpResponse: httpResponse)
    }

    /// Maps URLError to ClientError.
    private static func mapURLError(_ error: URLError) -> ClientError {
        switch error.code {
        case .timedOut:
            return .timeout
        case .cancelled:
            return .cancelled
        default:
            return .networkError(error)
        }
    }
}
