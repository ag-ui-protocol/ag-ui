// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class RunAgentInputStateTests: XCTestCase {
    func testArrayStateRoundTrips() throws {
        try assertStateRoundTrip("[1,2]")
        try assertStateRoundTrip("[]")
    }

    func testNumberStateRoundTrips() throws {
        for value in ["42", "0", "1", "-3", "1.5"] {
            try assertStateRoundTrip(value)
        }
    }

    func testStringStateRoundTrips() throws {
        try assertStateRoundTrip(#""hello""#)
        try assertStateRoundTrip(#""""#)
    }

    func testBooleanStateRoundTrips() throws {
        try assertStateRoundTrip("true")
        try assertStateRoundTrip("false")
    }

    func testNestedStateRoundTrips() throws {
        try assertStateRoundTrip(#"[null,{"items":[0,1,true,false,"hello",null]},[]]"#)
    }

    func testDefaultStateRemainsEmptyObject() throws {
        let input = RunAgentInput(threadId: "t", runId: "r")
        let wire = try AGUIJSON.parse(JSONEncoder().encode(input))
        XCTAssertEqual(wire.object?["state"], .object([:]))
        try assertStateRoundTrip("{}")
    }

    func testMalformedAndNullStateAreRejected() {
        for value in ["null", "not JSON", ""] {
            let input = RunAgentInput(threadId: "t", runId: "r", state: Data(value.utf8))
            XCTAssertThrowsError(try JSONEncoder().encode(input), value)
        }
    }

    func testMissingAndLegacyNullStateDecodeAsEmptyObject() throws {
        for json in [#"{"threadId":"t","runId":"r"}"#,
                     #"{"threadId":"t","runId":"r","state":null}"#] {
            let input = try JSONDecoder().decode(RunAgentInput.self, from: Data(json.utf8))
            XCTAssertEqual(try AGUIJSON.parse(input.state), .object([:]))
            let wire = try AGUIJSON.parse(JSONEncoder().encode(input))
            XCTAssertEqual(wire.object?["state"], .object([:]))
        }
    }

    private func assertStateRoundTrip(
        _ json: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) throws {
        let expected = try AGUIJSON.parse(Data(json.utf8))
        let input = RunAgentInput(threadId: "t", runId: "r", state: Data(json.utf8))
        let encoded = try JSONEncoder().encode(input)
        XCTAssertEqual(try AGUIJSON.parse(encoded).object?["state"], expected, file: file, line: line)

        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)
        XCTAssertEqual(try AGUIJSON.parse(decoded.state), expected, file: file, line: line)
        let reencoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(try AGUIJSON.parse(reencoded).object?["state"], expected, file: file, line: line)
    }
}
