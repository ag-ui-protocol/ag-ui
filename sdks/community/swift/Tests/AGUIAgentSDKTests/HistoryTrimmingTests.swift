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

import AGUICore
@testable import AGUIAgentSDK
import XCTest

final class HistoryTrimmingTests: XCTestCase {

    // MARK: - Basic Trimming

    func testTrimNoEffectWhenUnderLimit() async throws {
        // Given: History with 3 messages and limit of 5
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "Hello"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "Hi"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "How are you?"), to: "thread-1")

        // When: Trimming to 5
        await manager.trim(threadId: "thread-1", maxLength: 5)

        // Then: All messages should remain
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "msg1")
        XCTAssertEqual(history[1].id, "msg2")
        XCTAssertEqual(history[2].id, "msg3")
    }

    func testTrimRemovesOldestMessages() async throws {
        // Given: History with 5 messages
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg4", content: "4"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg5", content: "5"), to: "thread-1")

        // When: Trimming to 3
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: Should keep last 3 messages
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertEqual(history[0].id, "msg3")
        XCTAssertEqual(history[1].id, "msg4")
        XCTAssertEqual(history[2].id, "msg5")
    }

    // MARK: - System Message Preservation

    func testTrimPreservesSystemMessage() async throws {
        // Given: History with system message and 4 user/assistant messages
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "You are helpful"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg4", content: "4"), to: "thread-1")

        // When: Trimming to 3
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: System message + last 2 messages
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 3)
        XCTAssertTrue(history[0] is SystemMessage)
        XCTAssertEqual(history[0].id, "sys1")
        XCTAssertEqual(history[1].id, "msg3")
        XCTAssertEqual(history[2].id, "msg4")
    }

    func testTrimWithOnlySystemMessage() async throws {
        // Given: History with only system message
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "You are helpful"), to: "thread-1")

        // When: Trimming to 3
        await manager.trim(threadId: "thread-1", maxLength: 3)

        // Then: System message should remain
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].id, "sys1")
    }

    func testTrimWithSystemMessageAndOneOther() async throws {
        // Given: System message + one user message, trim to 1
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "System"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "User"), to: "thread-1")

        // When: Trimming to 1
        await manager.trim(threadId: "thread-1", maxLength: 1)

        // Then: Only system message remains
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].id, "sys1")
    }

    // MARK: - Edge Cases

    func testTrimToZeroWithoutSystemMessage() async throws {
        // Given: History with 3 messages, no system message
        let manager = ConversationHistoryManager()
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")

        // When: Trimming to 0
        await manager.trim(threadId: "thread-1", maxLength: 0)

        // Then: All messages removed
        let history = await manager.history(for: "thread-1")
        XCTAssertTrue(history.isEmpty)
    }

    func testTrimToOneWithSystemMessage() async throws {
        // Given: System message + 3 others
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys1", content: "System"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg1", content: "1"), to: "thread-1")
        await manager.append(message: AssistantMessage(id: "msg2", content: "2"), to: "thread-1")
        await manager.append(message: UserMessage(id: "msg3", content: "3"), to: "thread-1")

        // When: Trimming to 1
        await manager.trim(threadId: "thread-1", maxLength: 1)

        // Then: Only system message remains
        let history = await manager.history(for: "thread-1")
        XCTAssertEqual(history.count, 1)
        XCTAssertEqual(history[0].id, "sys1")
    }

    func testTrimNonexistentThread() async throws {
        // Given: Empty manager
        let manager = ConversationHistoryManager()

        // When: Trimming nonexistent thread
        await manager.trim(threadId: "nonexistent", maxLength: 5)

        // Then: Should not crash, history still empty
        let history = await manager.history(for: "nonexistent")
        XCTAssertTrue(history.isEmpty)
    }

    // MARK: - Realistic Scenarios

    func testRealisticConversationTrim() async throws {
        // Given: A realistic conversation
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys", content: "You are helpful"), to: "chat")
        await manager.append(message: UserMessage(id: "u1", content: "Hello"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a1", content: "Hi!"), to: "chat")
        await manager.append(message: UserMessage(id: "u2", content: "Weather?"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a2", content: "Sunny"), to: "chat")
        await manager.append(message: UserMessage(id: "u3", content: "Thanks"), to: "chat")
        await manager.append(message: AssistantMessage(id: "a3", content: "Welcome"), to: "chat")

        // When: Trimming to keep last 2 exchanges (4 messages + system)
        await manager.trim(threadId: "chat", maxLength: 5)

        // Then: System + last 4 messages
        let history = await manager.history(for: "chat")
        XCTAssertEqual(history.count, 5)
        XCTAssertEqual(history[0].id, "sys")
        XCTAssertEqual(history[1].id, "u2")
        XCTAssertEqual(history[2].id, "a2")
        XCTAssertEqual(history[3].id, "u3")
        XCTAssertEqual(history[4].id, "a3")
    }

    func testAggressiveTrimToSystemOnly() async throws {
        // Given: Long conversation
        let manager = ConversationHistoryManager()
        await manager.append(message: SystemMessage(id: "sys", content: "System"), to: "chat")
        for i in 1...10 {
            await manager.append(message: UserMessage(id: "u\(i)", content: "\(i)"), to: "chat")
            await manager.append(message: AssistantMessage(id: "a\(i)", content: "\(i)"), to: "chat")
        }

        // When: Aggressively trimming to 2
        await manager.trim(threadId: "chat", maxLength: 2)

        // Then: System + last 1 message
        let history = await manager.history(for: "chat")
        XCTAssertEqual(history.count, 2)
        XCTAssertEqual(history[0].id, "sys")
        XCTAssertEqual(history[1].id, "a10")
    }
}
