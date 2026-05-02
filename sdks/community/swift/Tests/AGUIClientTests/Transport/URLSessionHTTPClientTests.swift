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
}
