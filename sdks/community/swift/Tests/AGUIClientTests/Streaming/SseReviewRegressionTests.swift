import AGUICore
import Foundation
import XCTest
@testable import AGUIClient

final class SseReviewRegressionTests: XCTestCase {
    func testCRLFMultilineFrameAcrossEverySplit() throws {
        let wire = "id: cursor\r\ndata: {\r\ndata: \"type\":\"CUSTOM\",\"name\":\"test\",\"value\":null}\r\n\r\n"
        let bytes = Array(wire.utf8)
        for split in 0...bytes.count {
            var parser = SseParser()
            var events = try parser.parse(String(decoding: bytes[..<split], as: UTF8.self))
            events += try parser.parse(String(decoding: bytes[split...], as: UTF8.self))
            XCTAssertEqual(events.count, 1, "split \(split)")
            XCTAssertEqual(events.first?.id, "cursor")
            XCTAssertNoThrow(try AGUIEventDecoder().decode(Data(try XCTUnwrap(events.first).data.utf8)))
        }
    }

    func testLargeFrameThroughOneByteTransport() async throws {
        let payload = String(repeating: "x", count: 65_536)
        let wire = "id: large\r\ndata: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m\",\"delta\":\"\(payload)\"}\r\n\r\n"
        let bytes = AsyncStream<UInt8> { continuation in
            for byte in wire.utf8 { continuation.yield(byte) }
            continuation.finish()
        }
        let stream = EventStream(bytes: bytes, decoder: AGUIEventDecoder())
        var iterator = stream.makeAsyncIterator()
        let event = try await iterator.next()
        XCTAssertEqual((event as? TextMessageContentEvent)?.delta, payload)
        let cursor = await stream.lastEventId
        XCTAssertEqual(cursor, "large")
    }
}
