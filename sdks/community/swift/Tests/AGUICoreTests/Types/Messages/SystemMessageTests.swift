/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import XCTest
@testable import AGUICore

/// Tests for the SystemMessage type
final class SystemMessageTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithRequiredFields() {
        let message = SystemMessage(
            id: "sys-1",
            content: "You are a helpful assistant."
        )

        XCTAssertEqual(message.id, "sys-1")
        XCTAssertEqual(message.content, "You are a helpful assistant.")
        XCTAssertNil(message.name)
        XCTAssertEqual(message.role, .system)
    }

    func testInitWithAllFields() {
        let message = SystemMessage(
            id: "sys-2",
            content: "Be concise and professional.",
            name: "ProfessionalAssistant"
        )

        XCTAssertEqual(message.id, "sys-2")
        XCTAssertEqual(message.content, "Be concise and professional.")
        XCTAssertEqual(message.name, "ProfessionalAssistant")
        XCTAssertEqual(message.role, .system)
    }

    func testInitWithNilContent() {
        let message = SystemMessage(
            id: "sys-3",
            content: nil
        )

        XCTAssertEqual(message.id, "sys-3")
        XCTAssertNil(message.content)
        XCTAssertNil(message.name)
        XCTAssertEqual(message.role, .system)
    }

    // MARK: - Message Protocol Conformance Tests

    func testConformsToMessageProtocol() {
        let message: any Message = SystemMessage(
            id: "sys-4",
            content: "Test message"
        )

        XCTAssertEqual(message.id, "sys-4")
        XCTAssertEqual(message.role, .system)
        XCTAssertEqual(message.content, "Test message")
    }

    func testRoleIsAlwaysSystem() {
        let message1 = SystemMessage(id: "1", content: "Message 1")
        let message2 = SystemMessage(id: "2", content: nil, name: "System")

        XCTAssertEqual(message1.role, .system)
        XCTAssertEqual(message2.role, .system)
    }

    // MARK: - Serialization Tests (via DTO)

    // Note: SystemMessage no longer directly supports Codable.
    // Serialization is handled through SystemMessageDTO and MessageDecoder.
    // These tests verify that the DTO layer works correctly.

    // MARK: - Decoding Tests (via MessageDecoder)

    func testDecodingWithContent() throws {
        let json = """
        {
            "id": "sys-decode-1",
            "role": "system",
            "content": "You are a coding assistant."
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is SystemMessage)
        let sysMessage = message as! SystemMessage
        XCTAssertEqual(sysMessage.id, "sys-decode-1")
        XCTAssertEqual(sysMessage.role, .system)
        XCTAssertEqual(sysMessage.content, "You are a coding assistant.")
        XCTAssertNil(sysMessage.name)
    }

    func testDecodingWithAllFields() throws {
        let json = """
        {
            "id": "sys-decode-2",
            "role": "system",
            "content": "Be professional.",
            "name": "ProfessionalMode"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is SystemMessage)
        let sysMessage = message as! SystemMessage
        XCTAssertEqual(sysMessage.id, "sys-decode-2")
        XCTAssertEqual(sysMessage.role, .system)
        XCTAssertEqual(sysMessage.content, "Be professional.")
        XCTAssertEqual(sysMessage.name, "ProfessionalMode")
    }

    func testDecodingWithNilContent() throws {
        let json = """
        {
            "id": "sys-decode-3",
            "role": "system"
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is SystemMessage)
        let sysMessage = message as! SystemMessage
        XCTAssertEqual(sysMessage.id, "sys-decode-3")
        XCTAssertEqual(sysMessage.role, .system)
        XCTAssertNil(sysMessage.content)
        XCTAssertNil(sysMessage.name)
    }

    func testDecodingWithNullContent() throws {
        let json = """
        {
            "id": "sys-decode-4",
            "role": "system",
            "content": null
        }
        """

        let decoder = MessageDecoder()
        let message = try decoder.decode(Data(json.utf8))

        XCTAssertTrue(message is SystemMessage)
        let sysMessage = message as! SystemMessage
        XCTAssertEqual(sysMessage.id, "sys-decode-4")
        XCTAssertNil(sysMessage.content)
    }

    func testDecodingFailsWithoutId() {
        let json = """
        {
            "role": "system",
            "content": "Test"
        }
        """

        let decoder = MessageDecoder()
        XCTAssertThrowsError(try decoder.decode(Data(json.utf8))) { error in
            XCTAssertTrue(error is MessageDecodingError || error is DecodingError)
        }
    }

    func testDecodingFailsWithWrongRole() {
        let json = """
        {
            "id": "sys-1",
            "role": "user",
            "content": "Test"
        }
        """

        // With polymorphic MessageDecoder, wrong role returns different message type
        let decoder = MessageDecoder()
        let message = try? decoder.decode(Data(json.utf8))

        // Should decode as UserMessage, not SystemMessage
        XCTAssertNotNil(message)
        XCTAssertFalse(message is SystemMessage)
        XCTAssertTrue(message is UserMessage)
    }

    // MARK: - Round-trip Tests (via DTO layer)

    func testRoundTripWithContent() throws {
        // Create original message
        let original = SystemMessage(
            id: "sys-roundtrip-1",
            content: "You are an expert Swift developer.",
            name: "SwiftExpert"
        )

        // Encode via DTO (simulating what RunAgentInput does)
        let dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue,
            "content": original.content as Any,
            "name": original.name as Any
        ]
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is SystemMessage)
        let sysMessage = decoded as! SystemMessage
        XCTAssertEqual(sysMessage.id, original.id)
        XCTAssertEqual(sysMessage.role, original.role)
        XCTAssertEqual(sysMessage.content, original.content)
        XCTAssertEqual(sysMessage.name, original.name)
    }

    func testRoundTripWithNilContent() throws {
        // Create original message
        let original = SystemMessage(
            id: "sys-roundtrip-2",
            content: nil
        )

        // Encode via DTO (simulating what RunAgentInput does)
        var dict: [String: Any] = [
            "id": original.id,
            "role": original.role.rawValue
        ]
        if let content = original.content {
            dict["content"] = content
        }
        let encoded = try JSONSerialization.data(withJSONObject: dict)

        // Decode via MessageDecoder
        let decoder = MessageDecoder()
        let decoded = try decoder.decode(encoded)

        XCTAssertTrue(decoded is SystemMessage)
        let sysMessage = decoded as! SystemMessage
        XCTAssertEqual(sysMessage.id, original.id)
        XCTAssertEqual(sysMessage.role, original.role)
        XCTAssertNil(sysMessage.content)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let message1 = SystemMessage(id: "1", content: "Test", name: "Sys")
        let message2 = SystemMessage(id: "1", content: "Test", name: "Sys")
        let message3 = SystemMessage(id: "2", content: "Test", name: "Sys")
        let message4 = SystemMessage(id: "1", content: "Different", name: "Sys")
        let message5 = SystemMessage(id: "1", content: nil, name: "Sys")

        XCTAssertEqual(message1, message2)
        XCTAssertNotEqual(message1, message3)
        XCTAssertNotEqual(message1, message4)
        XCTAssertNotEqual(message1, message5)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let message1 = SystemMessage(id: "1", content: "Test")
        let message2 = SystemMessage(id: "2", content: "Test")

        let set: Set<SystemMessage> = [message1, message2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(message1))
        XCTAssertTrue(set.contains(message2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let message = SystemMessage(id: "sys-concurrent", content: "Test")

        Task {
            let capturedMessage = message
            XCTAssertEqual(capturedMessage.id, "sys-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testBehavioralGuidelines() {
        let guidelines = SystemMessage(
            id: "sys-behavioral-1",
            content: """
            You are a professional coding assistant. Guidelines:
            - Always explain your reasoning
            - Write clean, well-documented code
            - Follow best practices
            - Be concise but thorough
            """
        )

        XCTAssertEqual(guidelines.role, .system)
        XCTAssertTrue(guidelines.content?.contains("professional") ?? false)
    }

    func testPersonalityTraits() {
        let personality = SystemMessage(
            id: "sys-personality-1",
            content: "You are friendly, patient, and encouraging in all interactions.",
            name: "FriendlyAssistant"
        )

        XCTAssertEqual(personality.role, .system)
        XCTAssertEqual(personality.name, "FriendlyAssistant")
    }

    func testContextSetting() {
        let context = SystemMessage(
            id: "sys-context-1",
            content: "You are helping a beginner learn Swift programming. Be patient and explain concepts clearly."
        )

        XCTAssertNotNil(context.content)
        XCTAssertTrue(context.content?.contains("beginner") ?? false)
    }
}
