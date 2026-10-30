import AGUICore
import XCTest
@testable import AGUIClient

final class HttpAgentStreamLifetimeTests: XCTestCase {
    func testReturnedStreamSurvivesShortLivedAgent() async throws {
        TwoChunkURLProtocol.reset()
        let firstChunk = expectation(description: "first chunk delivered")
        let completed = expectation(description: "stream completed")

        // The agent, transport, and client all leave scope before iteration.
        // Their URLSession must remain valid until the returned stream ends.
        func makeStream() async throws -> EventStream<AsyncThrowingStream<UInt8, Error>> {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [TwoChunkURLProtocol.self]
            let client = URLSessionHTTPClient(session: URLSession(configuration: config))
            let configuration = HttpAgentConfiguration(baseURL: URL(string: "https://lifetime.test")!)
            var agent: HttpAgent? = HttpAgent(configuration: configuration, httpClient: client)
            let stream = try await agent!.run(RunAgentInput(threadId: "thread", runId: "run"))
            agent = nil
            return stream
        }

        let stream = try await makeStream()
        let consumer = Task {
            defer { completed.fulfill() }
            do {
                var deltas: [String] = []
                for try await event in stream {
                    if let content = event as? TextMessageContentEvent {
                        deltas.append(content.delta)
                        if deltas.count == 1 { firstChunk.fulfill() }
                    }
                }
                XCTAssertEqual(deltas, ["first", "second"])
            } catch {
                XCTFail("short-lived agent cancelled its active stream: \(error)")
            }
        }

        await fulfillment(of: [firstChunk], timeout: 2)
        TwoChunkURLProtocol.sendRest()
        await fulfillment(of: [completed], timeout: 2)
        consumer.cancel()
    }
}

/// Delivers one SSE event, pauses, then sends a second event and completes on cue.
private final class TwoChunkURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private static var active: TwoChunkURLProtocol?

    static func reset() {
        lock.lock(); defer { lock.unlock() }
        active = nil
    }

    static func sendRest() {
        lock.lock()
        let current = active
        active = nil
        lock.unlock()
        guard let current else { return }
        current.client?.urlProtocol(current, didLoad: Data(Self.secondEvent.utf8))
        current.client?.urlProtocolDidFinishLoading(current)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.active = self
        Self.lock.unlock()
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "text/event-stream"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.firstEvent.utf8))
    }

    override func stopLoading() {
        Self.lock.lock()
        if Self.active === self { Self.active = nil }
        Self.lock.unlock()
    }

    private static let firstEvent = "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m\",\"delta\":\"first\"}\n\n"
    private static let secondEvent = "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m\",\"delta\":\"second\"}\n\n"
}
