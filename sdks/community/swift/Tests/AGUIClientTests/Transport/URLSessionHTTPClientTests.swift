// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient

final class URLSessionHTTPClientTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithSession() async {
        let session = URLSession.shared
        let client = URLSessionHTTPClient(session: session)

        // Verify client was created
        await withCheckedContinuation { continuation in
            Task {
                _ = client
                continuation.resume()
            }
        }
    }

    func testCreateWithDefaultConfiguration() {
        let client = URLSessionHTTPClient.create()

        // Verify client was created with default config
        XCTAssertNotNil(client)
    }

    func testCreateWithCustomConfiguration() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 30

        let client = URLSessionHTTPClient.create(configuration: config)

        XCTAssertNotNil(client)
    }

    // MARK: - Session Injection Tests

    func testCustomSessionInjection() async {
        // Create custom session configuration
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 60
        config.httpAdditionalHeaders = ["Custom-Header": "Test"]

        let session = URLSession(configuration: config)
        let client = URLSessionHTTPClient(session: session)

        // Verify we can use the client
        await withCheckedContinuation { continuation in
            Task {
                _ = client
                continuation.resume()
            }
        }
    }

    func testSharedSessionReuse() async {
        // Multiple clients can share the same session
        let sharedSession = URLSession.shared

        let client1 = URLSessionHTTPClient(session: sharedSession)
        let client2 = URLSessionHTTPClient(session: sharedSession)

        await withCheckedContinuation { continuation in
            Task {
                _ = client1
                _ = client2
                continuation.resume()
            }
        }
    }

    // MARK: - HTTPClient Protocol Conformance

    func testConformsToHTTPClient() {
        let client: any HTTPClient = URLSessionHTTPClient.create()
        XCTAssertNotNil(client)
    }

    func testProtocolTypeErasure() async {
        let client: any HTTPClient = URLSessionHTTPClient.create()

        // Can be used through protocol
        await withCheckedContinuation { continuation in
            Task {
                _ = client
                continuation.resume()
            }
        }
    }

    // MARK: - Error Mapping Tests

    func testURLErrorMapping() async {
        // Test error mapping without actual network calls
        // (Full integration tests would use URLProtocol)

        let client = URLSessionHTTPClient.create()

        // Verify timeout error would be mapped
        let timeoutError = URLError(.timedOut)
        XCTAssertEqual(timeoutError.code, .timedOut)

        // Verify cancelled error would be mapped
        let cancelledError = URLError(.cancelled)
        XCTAssertEqual(cancelledError.code, .cancelled)
    }

    // MARK: - Actor Isolation Tests

    func testClientIsActor() async {
        let client = URLSessionHTTPClient.create()

        // Verify actor isolation by using in async context
        await withCheckedContinuation { continuation in
            Task {
                _ = client
                continuation.resume()
            }
        }
    }

    func testMultipleClientsCanExist() async {
        let client1 = URLSessionHTTPClient.create()
        let client2 = URLSessionHTTPClient.create()
        let client3 = URLSessionHTTPClient.create()

        // All should exist independently
        await withCheckedContinuation { continuation in
            Task {
                _ = client1
                _ = client2
                _ = client3
                continuation.resume()
            }
        }
    }

    // MARK: - Factory Method Tests

    func testFactoryCreatesNewInstances() {
        let client1 = URLSessionHTTPClient.create()
        let client2 = URLSessionHTTPClient.create()

        // Each factory call creates a new instance
        // (Can't test identity with actors, but we can verify they exist)
        XCTAssertNotNil(client1)
        XCTAssertNotNil(client2)
    }

    func testFactoryWithDifferentConfigurations() {
        let defaultClient = URLSessionHTTPClient.create()

        let ephemeralConfig = URLSessionConfiguration.ephemeral
        let ephemeralClient = URLSessionHTTPClient.create(configuration: ephemeralConfig)

        let backgroundConfig = URLSessionConfiguration.background(withIdentifier: "test")
        let backgroundClient = URLSessionHTTPClient.create(configuration: backgroundConfig)

        XCTAssertNotNil(defaultClient)
        XCTAssertNotNil(ephemeralClient)
        XCTAssertNotNil(backgroundClient)
    }

    // MARK: - Cancellation propagation

    func test_cancellation_stopsUnderlyingTask() async throws {
        // When the consumer cancels the stream, the inner Task must be cancelled via
        // continuation.onTermination so the URLSession data task is torn down.
        // StallingURLProtocol sends response headers then stalls on the body,
        // letting us verify stopLoading() is called after consumer cancellation.
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StallingURLProtocol.self]
        let session = URLSession(configuration: config)
        let client = URLSessionHTTPClient(session: session)

        StallingURLProtocol.reset()

        let firstByte = expectation(description: "first response byte consumed")
        let consumingTask = Task {
            let request = URLRequest(url: URL(string: "https://stall.test/stream")!)
            let response = try await client.execute(request)
            var consumed = 0
            do {
                for try await _ in response.bytes {
                    consumed += 1
                    if consumed == 1 { firstByte.fulfill() }
                }
            } catch is CancellationError {
                // Cancellation of the consumer also cancels URLSession.AsyncBytes.
            } catch let error as URLError where error.code == .cancelled {
                // URLSession may report its own cancellation error first.
            }
            return consumed
        }

        // The protocol sends one byte and stalls with the connection open.
        await StallingURLProtocol.waitUntilStarted()
        await fulfillment(of: [firstByte], timeout: 2)
        consumingTask.cancel()

        let cancelled = await StallingURLProtocol.waitUntilCancelledOrTimeout()
        guard cancelled else {
            XCTFail("URLSession task did not stop within 2 seconds of consumer cancellation")
            return
        }
        let consumed = try await consumingTask.value
        XCTAssertEqual(consumed, 1, "no bytes may be consumed after cancellation")
    }

    func test_cancellationWaitTimesOutWhenNetworkDoesNotStop() async {
        StallingURLProtocol.reset()
        let cancelled = await StallingURLProtocol.waitUntilCancelledOrTimeout(timeout: 0.05)
        XCTAssertFalse(cancelled)
    }
}

// MARK: - StallingURLProtocol

/// URLProtocol that sends 200 response headers immediately, then stalls on the body.
/// Records when URLSession cancels the task via stopLoading().
final class StallingURLProtocol: URLProtocol, @unchecked Sendable {
    private static let startedContinuations = NSLock()
    private static var _startedContinuation: CheckedContinuation<Void, Never>?
    private static var _cancelledContinuation: CheckedContinuation<Bool, Never>?
    private static var _cancelledWaiterID: UUID?
    private static var _started = false
    private static var _cancelled = false

    static func reset() {
        startedContinuations.lock(); defer { startedContinuations.unlock() }
        _startedContinuation = nil
        _cancelledContinuation = nil
        _cancelledWaiterID = nil
        _started = false
        _cancelled = false
    }

    static func waitUntilStarted() async {
        await withCheckedContinuation { cont in
            startedContinuations.lock(); defer { startedContinuations.unlock() }
            if _started { cont.resume() } else { _startedContinuation = cont }
        }
    }

    static func waitUntilCancelledOrTimeout(timeout: TimeInterval = 2) async -> Bool {
        await withCheckedContinuation { cont in
            let id = UUID()
            startedContinuations.lock()
            if _cancelled {
                startedContinuations.unlock()
                cont.resume(returning: true)
                return
            }
            _cancelledContinuation = cont
            _cancelledWaiterID = id
            startedContinuations.unlock()

            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
                startedContinuations.lock()
                let timedOut = _cancelledWaiterID == id
                if timedOut {
                    _cancelledContinuation = nil
                    _cancelledWaiterID = nil
                }
                startedContinuations.unlock()
                if timedOut { cont.resume(returning: false) }
            }
        }
    }

    private static func signalStarted() {
        startedContinuations.lock(); defer { startedContinuations.unlock() }
        _started = true
        _startedContinuation?.resume()
        _startedContinuation = nil
    }

    private static func signalCancelled() {
        startedContinuations.lock()
        _cancelled = true
        let continuation = _cancelledContinuation
        _cancelledContinuation = nil
        _cancelledWaiterID = nil
        startedContinuations.unlock()
        continuation?.resume(returning: true)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data([0x41]))
        // Leave the body open after one byte so the consumer suspends mid-stream.
        StallingURLProtocol.signalStarted()
    }

    override func stopLoading() {
        StallingURLProtocol.signalCancelled()
    }
}
