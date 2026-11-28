// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation
import XCTest
@testable import AGUIClient

final class URLSessionHTTPClientOwnershipTests: XCTestCase {
    func testDeinitDoesNotInvalidateCallerOwnedSession() async {
        let invalidated = expectation(description: "caller-owned session must remain valid")
        invalidated.isInverted = true
        let observer = SessionInvalidationObserver(expectation: invalidated)
        let session = URLSession(configuration: .ephemeral, delegate: observer, delegateQueue: nil)
        defer {
            observer.stopObserving()
            session.invalidateAndCancel()
        }
        var client: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        weak var weakClient = client

        XCTAssertNotNil(weakClient)
        client = nil

        XCTAssertNil(weakClient, "The caller should retain the session, not the wrapper")
        await fulfillment(of: [invalidated], timeout: 0.2)
        XCTAssertEqual(observer.invalidationCount, 0)
    }

    func testDeinitDoesNotInvalidateSessionSharedByOtherClients() async {
        let invalidated = expectation(description: "shared session must remain valid")
        invalidated.isInverted = true
        let observer = SessionInvalidationObserver(expectation: invalidated)
        let session = URLSession(configuration: .ephemeral, delegate: observer, delegateQueue: nil)
        defer {
            observer.stopObserving()
            session.invalidateAndCancel()
        }
        var firstClient: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        var secondClient: URLSessionHTTPClient? = URLSessionHTTPClient(session: session)
        weak var weakFirstClient = firstClient
        weak var weakSecondClient = secondClient

        withExtendedLifetime(secondClient) {
            firstClient = nil

            XCTAssertNil(weakFirstClient)
            XCTAssertNotNil(weakSecondClient)
        }

        secondClient = nil

        XCTAssertNil(weakSecondClient)
        await fulfillment(of: [invalidated], timeout: 0.2)
        XCTAssertEqual(observer.invalidationCount, 0, "The session still belongs to the caller")
    }

    func testDeinitInvalidatesOwnedSession() async {
        let invalidated = expectation(description: "owned session invalidated")
        let observer = SessionInvalidationObserver(expectation: invalidated)
        let session = URLSession(configuration: .ephemeral, delegate: observer, delegateQueue: nil)
        defer {
            observer.stopObserving()
            session.invalidateAndCancel()
        }
        var client: URLSessionHTTPClient? = URLSessionHTTPClient(
            session: session,
            shouldInvalidateSession: true
        )
        weak var weakClient = client

        XCTAssertNotNil(weakClient)
        XCTAssertEqual(observer.invalidationCount, 0)
        client = nil

        XCTAssertNil(weakClient)
        await fulfillment(of: [invalidated], timeout: 2)
        XCTAssertEqual(observer.invalidationCount, 1)
    }
}

/// Observes a real session without subclassing URLSession, whose initializers
/// differ between Darwin and FoundationNetworking. Never requests work from an invalidated session,
/// which can raise an Objective-C exception instead of a catchable Swift error.
private final class SessionInvalidationObserver: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    private var expectation: XCTestExpectation?

    init(expectation: XCTestExpectation) {
        self.expectation = expectation
        super.init()
    }

    var invalidationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }

    func stopObserving() {
        lock.lock()
        defer { lock.unlock() }
        expectation = nil
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        count += 1
        expectation?.fulfill()
    }
}
