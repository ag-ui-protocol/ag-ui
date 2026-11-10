// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation
import XCTest
@testable import AGUIClient

final class URLSessionHTTPClientOwnershipTests: XCTestCase {
    func testDeinitDoesNotInvalidateCallerOwnedSession() {
        let session = InvalidationTrackingSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var client: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        weak var weakClient = client

        XCTAssertNotNil(weakClient)
        client = nil

        XCTAssertNil(weakClient, "The caller should retain the session, not the wrapper")
        XCTAssertEqual(session.invalidationCount, 0)
    }

    func testDeinitDoesNotInvalidateSessionSharedByOtherClients() {
        let session = InvalidationTrackingSession(configuration: .ephemeral)
        defer { session.invalidateAndCancel() }
        var firstClient: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        var secondClient: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        weak var weakFirstClient = firstClient
        weak var weakSecondClient = secondClient

        withExtendedLifetime(secondClient) {
            firstClient = nil

            XCTAssertNil(weakFirstClient)
            XCTAssertNotNil(weakSecondClient)
            XCTAssertEqual(session.invalidationCount, 0, "Another client still uses the session")
        }

        secondClient = nil

        XCTAssertNil(weakSecondClient)
        XCTAssertEqual(session.invalidationCount, 0, "The session still belongs to the caller")
    }

    func testDeinitInvalidatesOwnedSession() {
        let session = InvalidationTrackingSession(configuration: .ephemeral)
        var client: URLSessionHTTPClient? = URLSessionHTTPClient(
            session: session,
            shouldInvalidateSession: true
        )
        weak var weakClient = client

        XCTAssertNotNil(weakClient)
        XCTAssertEqual(session.invalidationCount, 0)
        client = nil

        XCTAssertNil(weakClient)
        XCTAssertEqual(session.invalidationCount, 1)
    }
}

/// Observes invalidation without creating a task on an invalidated session,
/// which can raise an Objective-C exception instead of a catchable Swift error.
private final class InvalidationTrackingSession: URLSession, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var invalidationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    override func invalidateAndCancel() {
        lock.lock()
        count += 1
        lock.unlock()
        super.invalidateAndCancel()
    }
}
