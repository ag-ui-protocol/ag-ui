import Foundation
import XCTest
@testable import AGUICore

final class MultimodalWireRegressionTests: XCTestCase {
    func testCanonicalUserMessageFixtureRoundTrips() throws {
        let root = URL(fileURLWithPath: #filePath).resolvingSymlinksInPath().deletingLastPathComponent()
            .appendingPathComponent("../../../../../").standardizedFileURL
        let data = try Data(contentsOf: root.appendingPathComponent("spec/1.0/fixtures/UserMessage/valid/multimodal-content.json"))
        let message = try MessageDecoder().decode(data)
        let output = try MessageEncoder().encode(message)
        _ = try AGUISchemaDocument(output, definition: "UserMessage")
        XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? NSObject,
                       try JSONSerialization.jsonObject(with: output) as? NSObject)
    }

    func testAllMediaSourcesAndMetadataRoundTrip() throws {
        for kind in ["image", "audio", "video", "document"] {
            for source in [
                #"{"type":"url","value":"https://example.com/media","mimeType":"image/png"}"#,
                #"{"type":"data","value":"aGk=","mimeType":"application/octet-stream"}"#,
                #"{"type":"file","value":"opaque:never-fetch","provider":"openai"}"#
            ] {
                // Metadata may be any non-null JSON value, including nested nulls.
                for metadata in [#"{"nested":[1,null,true]}"#, #"["a",2]"#, #""caption""#, "false"] {
                    let data = Data("""
                    {"id":"m","role":"user","content":[{"type":"\(kind)","id":"p","source":\(source),"metadata":\(metadata)}]}
                    """.utf8)
                    let output = try MessageEncoder().encode(MessageDecoder().decode(data))
                    _ = try AGUISchemaDocument(output, definition: "UserMessage")
                    XCTAssertEqual(try JSONSerialization.jsonObject(with: data) as? NSObject,
                                   try JSONSerialization.jsonObject(with: output) as? NSObject)
                }
            }
        }
    }

    func testInvalidCanonicalSourcesAreRejectedRatherThanFallingBackToLegacy() {
        for source in [#"{"type":"data","value":"aGk="}"#, #"{"type":"blob","value":"x"}"#, #"{"type":"url"}"#, "null"] {
            let data = Data("""
            {"type":"image","source":\(source),"url":"https://example.com/legacy"}
            """.utf8)
            XCTAssertThrowsError(try ImageInputContentDTO.decode(from: data))
        }
    }

    func testLegacyConstructorsProduceValidRunInputAndRoundTrip() throws {
        let message = UserMessage.multimodal(id: "m", parts: [
            ImageInputContent(url: "https://example.com/a.png", detail: "high", mimeType: "image/png"),
            AudioInputContent(data: "aGk=", format: "wav", mimeType: "audio/wav"),
            VideoInputContent(data: "aGk="),
            DocumentInputContent(url: "https://example.com/a.pdf", title: "Report"),
            ImageInputContent(source: .file(value: "file-123", provider: "openai"))
        ])
        let input = RunAgentInput(threadId: "t", runId: "r", messages: [message])
        let output = try JSONEncoder().encode(input)
        _ = try AGUISchemaDocument(output, definition: "RunAgentInput")
        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: output)
        let reencoded = try JSONEncoder().encode(decoded)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: output) as? NSObject,
                       try JSONSerialization.jsonObject(with: reencoded) as? NSObject)
    }
}
