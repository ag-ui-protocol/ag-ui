import Foundation
import XCTest
@testable import AGUICore

final class WireReviewRegressionTests: XCTestCase {
    func testEveryValidEventFixtureUsesRuntimeDecoder() throws {
        let root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath()
            .deletingLastPathComponent().appendingPathComponent("../../../../../spec/1.0/fixtures")
            .standardizedFileURL
        let paths = try FileManager.default.subpathsOfDirectory(atPath: root.path).sorted()
        let decoder = AGUIEventDecoder()
        for path in paths where path.contains("Event/valid/") && path.hasSuffix(".json") {
            let data = try Data(contentsOf: root.appendingPathComponent(path))
            XCTAssertNoThrow(try decoder.decode(data), path)
        }
    }

    func testRunFinishedPreservesEveryJSONResultWithoutFoundationScalarCrash() throws {
        for value in [#""done""#, "42", "9007199254740993", "1e400", "true", "null", "[]", "{}"] {
            let data = Data("{\"type\":\"RUN_FINISHED\",\"threadId\":\"t\",\"runId\":\"r\",\"result\":\(value)}".utf8)
            let event = try XCTUnwrap(AGUIEventDecoder().decode(data) as? RunFinishedEvent)
            XCTAssertEqual(try event.result.map(AGUIJSON.parse), try AGUIJSON.parse(Data(value.utf8)))
        }
    }

    func testRunStartedPreservesScalarAndLargeInputPayloads() throws {
        for value in [#""input""#, "9007199254740993", "true", "null", #"{"revision":9007199254740993}"#] {
            let data = Data("{\"type\":\"RUN_STARTED\",\"threadId\":\"t\",\"runId\":\"r\",\"input\":\(value)}".utf8)
            let event = try XCTUnwrap(AGUIEventDecoder().decode(data) as? RunStartedEvent)
            XCTAssertEqual(try event.input.map(AGUIJSON.parse), try AGUIJSON.parse(Data(value.utf8)))
        }
    }

    func testJSONNestingLimitAcceptsBoundaryAndRejectsBeyondIt() throws {
        let depth = AGUIJSON.maximumNestingDepth
        let boundary = String(repeating: "[", count: depth) + "0" + String(repeating: "]", count: depth)
        XCTAssertNoThrow(try AGUIJSON.parse(Data(boundary.utf8)))
        XCTAssertThrowsError(try AGUIJSON.parse(Data(("[" + boundary + "]").utf8)))
        let hostile = String(repeating: "[", count: 100_000) + "0" + String(repeating: "]", count: 100_000)
        XCTAssertThrowsError(try AGUIJSON.parse(Data(hostile.utf8)))
    }

    func testThinkingMessageStartUsesReasoningRole() throws {
        let event = try AGUIEventDecoder().decode(Data(#"{"type":"THINKING_TEXT_MESSAGE_START"}"#.utf8))
        let wire = try XCTUnwrap(event.rawEvent)
        XCTAssertEqual(try AGUIJSON.parse(wire).object?["role"]?.string, "reasoning")
    }
}
