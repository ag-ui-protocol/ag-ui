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

final class MessagesSnapshotEventTests: XCTestCase,
                                         AGUIEventDecoderTestHelpers,
                                         EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messages": [
                ["id": "msg-1", "role": "user", "content": "Hello"],
                ["id": "msg-2", "role": "assistant", "content": "Hi there!"]
            ]
        ]
    }

    var eventTypeString: String { "MESSAGES_SNAPSHOT" }
    var expectedEventType: EventType { .messagesSnapshot }
    var unknownEventTypeString: String { "UNKNOWN_MESSAGES_EVENT" }

    // MARK: - Feature: Decode MESSAGES_SNAPSHOT

    func test_decodeValidMessagesSnapshot_withArrayOfMessages_returnsMessagesSnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "role": "user",
              "content": "Hello, how are you?"
            },
            {
              "id": "msg-2",
              "role": "assistant",
              "content": "I'm doing well, thank you!"
            }
          ]
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let messagesSnapshot = event as? MessagesSnapshotEvent else {
            return XCTFail("Expected MessagesSnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(messagesSnapshot.eventType, .messagesSnapshot)
        XCTAssertNil(messagesSnapshot.timestamp)

        // Verify messages can be parsed
        let parsed = try messagesSnapshot.parsedMessages() as? [[String: Any]]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 2)
        XCTAssertEqual(parsed?[0]["id"] as? String, "msg-1")
        XCTAssertEqual(parsed?[0]["role"] as? String, "user")
        XCTAssertEqual(parsed?[1]["id"] as? String, "msg-2")
        XCTAssertEqual(parsed?[1]["role"] as? String, "assistant")
    }

    func test_decodeMessagesSnapshot_withEmptyArray_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": []
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 0)
    }

    func test_decodeMessagesSnapshot_withComplexMessageStructure_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "role": "user",
              "content": "Hello",
              "timestamp": 1234567890,
              "metadata": {
                "source": "web",
                "language": "en"
              }
            },
            {
              "id": "msg-2",
              "role": "assistant",
              "content": "Hi!",
              "toolCalls": [
                {
                  "id": "call-1",
                  "name": "search",
                  "args": {"query": "test"}
                }
              ]
            }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [[String: Any]]
        XCTAssertEqual(parsed?.count, 2)

        let firstMessage = parsed?[0]
        XCTAssertEqual(firstMessage?["id"] as? String, "msg-1")
        let metadata = firstMessage?["metadata"] as? [String: Any]
        XCTAssertEqual(metadata?["source"] as? String, "web")

        let secondMessage = parsed?[1]
        let toolCalls = secondMessage?["toolCalls"] as? [[String: Any]]
        XCTAssertEqual(toolCalls?.count, 1)
        XCTAssertEqual(toolCalls?[0]["name"] as? String, "search")
    }

    func test_decodeMessagesSnapshot_withUnicodeContent_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "role": "user",
              "content": "Hello, 🌍! 你好"
            }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [[String: Any]]
        XCTAssertEqual(parsed?[0]["content"] as? String, "Hello, 🌍! 你好")
    }

    func test_decodeMessagesSnapshot_withNullMessages_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": null
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages()
        XCTAssertTrue(parsed is NSNull)
    }

    func test_decodeMessagesSnapshot_withObjectInsteadOfArray_handlesCorrectly() throws {
        // Given (in case API sends object structure)
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": {
            "conversation": [
              {"id": "msg-1", "content": "test"}
            ],
            "total": 1
          }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["total"] as? Int, 1)
    }

    func test_decodeMessagesSnapshot_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {"id": "msg-1", "content": "test"}
          ],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.timestamp, EventTestData.timestamp)
    }

    func test_decodeMessagesSnapshot_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1"}],
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        XCTAssertEqual(messagesSnapshot.rawEvent, data)
    }

    func test_decodeMessagesSnapshot_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1"}],
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [[String: Any]]
        XCTAssertEqual(parsed?[0]["id"] as? String, "msg-1")
    }

    func test_decodeMessagesSnapshot_withMessagesContainingNestedArrays_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [
            {
              "id": "msg-1",
              "attachments": [
                {"type": "image", "url": "http://example.com/1.jpg"},
                {"type": "file", "url": "http://example.com/doc.pdf"}
              ]
            }
          ]
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let messagesSnapshot = try XCTUnwrap(event as? MessagesSnapshotEvent)
        let parsed = try messagesSnapshot.parsedMessages() as? [[String: Any]]
        let attachments = parsed?[0]["attachments"] as? [[String: Any]]
        XCTAssertEqual(attachments?.count, 2)
        XCTAssertEqual(attachments?[0]["type"] as? String, "image")
    }

    // MARK: - Feature: Error handling

    func test_decodeMessagesSnapshot_missingMessages_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messages") || message.contains("Missing key"))
        }
    }

    func test_decodeMessagesSnapshot_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "MESSAGES_SNAPSHOT",
          "messages": [{"id": "msg-1"}],
          "timestamp": "not-a-number"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("timestamp") || message.contains("Type mismatch"))
        }
    }

    // MARK: - Feature: Model behaviors

    func test_messagesSnapshotEvent_eventTypeIsAlwaysMessagesSnapshot() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .messagesSnapshot)
    }

    func test_messagesSnapshotEvent_equatable_sameMessages_areEqual() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event1 = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_messagesSnapshotEvent_equatable_differentMessages_areNotEqual() throws {
        // Given
        let messagesData1 = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let messagesData2 = try JSONSerialization.data(withJSONObject: [["id": "msg-2"]], options: [])
        let event1 = MessagesSnapshotEvent(messages: messagesData1, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = MessagesSnapshotEvent(messages: messagesData2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_messagesSnapshotEvent_equatable_differentTimestamps_areNotEqual() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event1 = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_messagesSnapshotEvent_equatable_oneWithTimestampOneWithout_areNotEqual() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event1 = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = MessagesSnapshotEvent(messages: messagesData, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_messagesSnapshotEvent_parsedMessages_returnsCorrectValue() throws {
        // Given
        let originalMessages: [[String: Any]] = [
            ["id": "msg-1", "content": "Hello"],
            ["id": "msg-2", "content": "World"]
        ]
        let messagesData = try JSONSerialization.data(withJSONObject: originalMessages, options: [])
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: nil, rawEvent: nil)

        // When
        let parsed = try event.parsedMessages() as? [[String: Any]]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 2)
        XCTAssertEqual(parsed?[0]["id"] as? String, "msg-1")
        XCTAssertEqual(parsed?[1]["content"] as? String, "World")
    }

    func test_messagesSnapshotEvent_parsedMessages_withInvalidData_throws() throws {
        // Given
        let invalidData = Data("not json".utf8)
        let event = MessagesSnapshotEvent(messages: invalidData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedMessages())
    }

    func test_messagesSnapshotEvent_parsedMessagesAs_withCodableType_decodesCorrectly() throws {
        // Given
        struct Message: Codable, Equatable {
            let id: String
            let role: String
            let content: String
        }

        let originalMessages = [
            Message(id: "msg-1", role: "user", content: "Hello"),
            Message(id: "msg-2", role: "assistant", content: "Hi!")
        ]
        let messagesData = try JSONEncoder().encode(originalMessages)
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: nil, rawEvent: nil)

        // When
        let decoded = try event.parsedMessages(as: [Message].self)

        // Then
        XCTAssertEqual(decoded.count, 2)
        XCTAssertEqual(decoded[0].id, "msg-1")
        XCTAssertEqual(decoded[0].role, "user")
        XCTAssertEqual(decoded[1].id, "msg-2")
        XCTAssertEqual(decoded[1].role, "assistant")
    }

    func test_messagesSnapshotEvent_parsedMessagesAs_withWrongType_throws() throws {
        // Given
        struct Message: Codable {
            let id: String
        }

        struct WrongMessage: Decodable {
            let wrongField: String
        }

        let originalMessages = [Message(id: "msg-1")]
        let messagesData = try JSONEncoder().encode(originalMessages)
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: nil, rawEvent: nil)

        // When / Then
        XCTAssertThrowsError(try event.parsedMessages(as: [WrongMessage].self)) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func test_messagesSnapshotEvent_description_containsKeyInformation() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("MessagesSnapshotEvent"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_messagesSnapshotEvent_debugDescription_containsDetailedInformation() throws {
        // Given
        let messagesData = try JSONSerialization.data(withJSONObject: [["id": "msg-1"]], options: [])
        let event = MessagesSnapshotEvent(messages: messagesData, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("MessagesSnapshotEvent"))
        XCTAssertTrue(debugDescription.contains("messages"))
    }
}
