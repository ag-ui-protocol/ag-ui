import Foundation
import XCTest
@testable import AGUICore

final class MessagesSnapshotMetadataProbeTests: XCTestCase {
    func testAssistantSnapshotPreservesOpenMetadataInDomainMessage() throws {
        let wire = Data("{\"type\":\"MESSAGES_SNAPSHOT\",\"messages\":[{\"id\":\"m\",\"role\":\"assistant\",\"content\":\"x\",\"metadata\":{\"provider\":\"acme\"}}]}".utf8)
        let event = try XCTUnwrap(try AGUIEventDecoder().decode(wire) as? MessagesSnapshotEvent)
        let assistant = try XCTUnwrap(event.messages.first as? AssistantMessage)
        let metadata = try XCTUnwrap(assistant.metadata)
        XCTAssertTrue(String(decoding: metadata, as: UTF8.self).contains("acme"))
    }

    func testSnapshotToolPartsSurviveDomainAndWireRoundTrip() throws {
        let huge = "1234567890123456789012345678901234567891234567890123456789"
        let wire = Data("""
        {"type":"MESSAGES_SNAPSHOT","messages":[
          {"id":"tool","role":"tool","toolCallId":"call","content":[
            {"type":"document","source":{"type":"file","value":"file-123"},"metadata":{"number":\(huge)}}]}
        ]}
        """.utf8)
        let event = try XCTUnwrap(AGUIEventDecoder().decode(wire) as? MessagesSnapshotEvent)
        let tool = try XCTUnwrap(event.messages.first as? ToolMessage)
        let parts = try XCTUnwrap(tool.contentParts)
        XCTAssertTrue(String(decoding: parts, as: UTF8.self).contains(huge))
        let encoded = try MessageEncoder().encode(tool)
        XCTAssertTrue(String(decoding: encoded, as: UTF8.self).contains(huge))
        let decoded = try XCTUnwrap(MessageDecoder().decode(encoded) as? ToolMessage)
        XCTAssertEqual(decoded.contentParts, parts)
        let direct = try JSONDecoder().decode(ToolMessage.self, from: encoded)
        XCTAssertNotNil(direct.contentParts)
    }

    func testSnapshotAssistantAndToolCallMetadataRetainLargeInteger() throws {
        let huge = "9876543210987654321098765432109876543210987654321098765432"
        let wire = Data("""
        {"type":"MESSAGES_SNAPSHOT","messages":[{"id":"a","role":"assistant","content":"x",
          "metadata":{"number":\(huge)},
          "toolCalls":[{"id":"c","type":"function","function":{"name":"search","arguments":"{}"},
            "metadata":{"number":\(huge)}}]}]}
        """.utf8)
        let event = try XCTUnwrap(AGUIEventDecoder().decode(wire) as? MessagesSnapshotEvent)
        let assistant = try XCTUnwrap(event.messages.first as? AssistantMessage)
        XCTAssertTrue(String(decoding: try XCTUnwrap(assistant.metadata), as: UTF8.self).contains(huge))
        XCTAssertTrue(String(decoding: try XCTUnwrap(assistant.toolCalls?.first?.metadata), as: UTF8.self).contains(huge))
        let encoded = try MessageEncoder().encode(assistant)
        XCTAssertEqual(String(decoding: encoded, as: UTF8.self).components(separatedBy: huge).count - 1, 2)
    }
}
