import Foundation
import XCTest
@testable import AGUICore

final class ForwardCompatibilityTests: XCTestCase {
    private var decoder: AGUIEventDecoder {
        var configuration = AGUIEventDecoder.Configuration()
        configuration.enforceForwardCompatibility = true
        return AGUIEventDecoder(config: configuration)
    }

    func testSchemaCoversEveryWireEvent() {
        XCTAssertEqual(AGUISchemaDocument.sanitizableEventTypes, Set(EventType.allCases))
    }

    func testUnknownFieldsAreRemovedBeforeRegistryForTextAndStepStarts() throws {
        for input in [
            #"{"type":"TEXT_MESSAGE_START","messageId":"m","role":"assistant","future":1,"metadata":{"future":2}}"#,
            #"{"type":"STEP_STARTED","stepName":"work","future":1,"metadata":{"future":2}}"#
        ] {
            let event = try decoder.decode(Data(input.utf8))
            let raw = try XCTUnwrap(event.rawEvent)
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
            XCTAssertNil(object["future"])
            XCTAssertEqual((object["metadata"] as? [String: Int])?["future"], 2)
        }
    }

    func testMalformedKnownOptionalsFailEvenWithUnknownFields() {
        for input in [
            #"{"type":"TEXT_MESSAGE_START","messageId":"m","name":42,"future":1}"#,
            #"{"type":"STEP_STARTED","stepName":"work","subagentRunId":42,"future":1}"#,
            #"{"type":"STEP_STARTED","stepName":"work","timestamp":"now","future":1}"#
        ] {
            XCTAssertThrowsError(try decoder.decode(Data(input.utf8)), input)
        }
    }

    func testNestedClosedFieldsStripWhileOpenValuesSurvive() throws {
        let data = Data(#"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":"assistant","content":"hello","future":1,"metadata":{"future":2}}],"future":3}"#.utf8)
        let event = try decoder.decode(data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(event.rawEvent)) as? [String: Any])
        XCTAssertNil(object["future"])
        let message = try XCTUnwrap((object["messages"] as? [[String: Any]])?.first)
        XCTAssertNil(message["future"])
        XCTAssertEqual((message["metadata"] as? [String: Int])?["future"], 2)
    }

    func testUnknownRequiredSourceDropsOnlyItsPart() throws {
        let data = Data(#"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":"user","content":[{"type":"text","text":"before"},{"type":"image","source":{"type":"hologram","value":"x"}},{"type":"text","text":"after"}]}]}"#.utf8)
        let event = try decoder.decode(data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(event.rawEvent)) as? [String: Any])
        let message = try XCTUnwrap((object["messages"] as? [[String: Any]])?.first)
        let content = try XCTUnwrap(message["content"] as? [[String: Any]])
        XCTAssertEqual(content.compactMap { $0["text"] as? String }, ["before", "after"])
    }

    func testPatchOperationRemainsOpen() throws {
        let data = Data(#"{"type":"STATE_DELTA","delta":[{"op":"remove","path":"/x","value":"keep"}],"future":1}"#.utf8)
        let event = try decoder.decode(data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(event.rawEvent)) as? [String: Any])
        XCTAssertNil(object["future"])
        XCTAssertEqual(((object["delta"] as? [[String: Any]])?.first)?["value"] as? String, "keep")
    }

    func testOpenStateNumberKeepsExactLexeme() throws {
        let digits = "1234567890123456789012345678901234567890"
        let event = try decoder.decode(Data("{\"type\":\"STATE_SNAPSHOT\",\"snapshot\":{\"value\":\(digits)},\"future\":1}".utf8))
        let raw = try XCTUnwrap(event.rawEvent)
        XCTAssertTrue(String(decoding: raw, as: UTF8.self).contains(digits))
        XCTAssertFalse(String(decoding: raw, as: UTF8.self).contains("future"))
    }

    func testMalformedUnionDiscriminatorsAreFatal() {
        for input in [
            #"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":42,"content":"hello"}]}"#,
            #"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":42}}"#,
            #"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":"user","content":[{"type":42,"text":"hello"}]}]}"#
        ] {
            XCTAssertThrowsError(try decoder.decode(Data(input.utf8)), input)
        }
    }

    func testWellTypedFutureUnionDiscriminatorsAreRemoved() throws {
        let messages = try decoder.decode(Data(#"{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"future","role":"hologram","content":"x"},{"id":"known","role":"user","content":"hello"}]}"#.utf8))
        XCTAssertEqual((messages as? MessagesSnapshotEvent)?.messages.count, 1)
        let finished = try decoder.decode(Data(#"{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"future"}}"#.utf8))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(finished.rawEvent)) as? [String: Any])
        XCTAssertNil(object["outcome"])
    }

    func testOpenEventPayloadsKeepLargeIntegersInDomainValues() throws {
        let digits = "1234567890123456789012345678901234567890123456789012345678"
        let cases: [(String, (any AGUIEvent) -> Data?)] = [
            ("{\"type\":\"STATE_SNAPSHOT\",\"snapshot\":{\"value\":\(digits)}}", { ($0 as? StateSnapshotEvent)?.snapshot }),
            ("{\"type\":\"STATE_DELTA\",\"delta\":[{\"op\":\"add\",\"path\":\"/x\",\"value\":\(digits)}]}", { ($0 as? StateDeltaEvent)?.delta }),
            ("{\"type\":\"RAW\",\"event\":{\"value\":\(digits)}}", { ($0 as? RawEvent)?.data }),
            ("{\"type\":\"CUSTOM\",\"name\":\"x\",\"value\":{\"value\":\(digits)}}", { ($0 as? CustomEvent)?.value }),
            ("{\"type\":\"ACTIVITY_SNAPSHOT\",\"messageId\":\"m\",\"activityType\":\"x\",\"content\":{\"value\":\(digits)}}", { ($0 as? ActivitySnapshotEvent)?.content }),
            ("{\"type\":\"ACTIVITY_DELTA\",\"messageId\":\"m\",\"activityType\":\"x\",\"patch\":[{\"op\":\"add\",\"path\":\"/x\",\"value\":\(digits)}]}", { ($0 as? ActivityDeltaEvent)?.patch })
        ]
        for (input, payload) in cases {
            let event = try decoder.decode(Data(input.utf8))
            let data = try XCTUnwrap(payload(event), input)
            XCTAssertTrue(String(decoding: data, as: UTF8.self).contains(digits), input)
        }
    }

    func testStructuredToolResultKeepsLargeIntegerInUsableContent() throws {
        let digits = "1234567890123456789012345678901234567890123456789012345678"
        let input = "{\"type\":\"TOOL_CALL_RESULT\",\"messageId\":\"m\",\"toolCallId\":\"tc\",\"content\":[{\"type\":\"text\",\"text\":\"hello\",\"metadata\":{\"value\":\(digits)}}]}"
        let event = try XCTUnwrap(try decoder.decode(Data(input.utf8)) as? ToolCallResultEvent)
        XCTAssertTrue(event.content.contains(digits))
    }

    func testMessagesSnapshotActivityContentKeepsLargeInteger() throws {
        let digits = "1234567890123456789012345678901234567890123456789012345678"
        let input = "{\"type\":\"MESSAGES_SNAPSHOT\",\"messages\":[{\"id\":\"m\",\"role\":\"activity\",\"activityType\":\"x\",\"content\":{\"value\":\(digits)}}]}"
        let event = try XCTUnwrap(try decoder.decode(Data(input.utf8)) as? MessagesSnapshotEvent)
        let message = try XCTUnwrap(event.messages.first as? ActivityMessage)
        XCTAssertTrue(String(decoding: message.content, as: UTF8.self).contains(digits))
    }

    func testMessagesSnapshotStillRejectsNonObjectMessageWithoutSchemaEnforcement() {
        let input = Data(#"{"type":"MESSAGES_SNAPSHOT","messages":[42]}"#.utf8)
        XCTAssertThrowsError(try AGUIEventDecoder().decode(input))
    }

}
