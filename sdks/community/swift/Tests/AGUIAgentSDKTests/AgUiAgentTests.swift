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
import AGUITools
import XCTest
@testable import AGUIAgentSDK

// MARK: - Test helpers

/// Subclass of `AgUiAgent` that captures every `RunAgentInput` passed to `run(input:)`.
private final class CapturingAgent: AgUiAgent, @unchecked Sendable {
    private let lock = NSLock()
    private var _inputs: [RunAgentInput] = []

    var capturedInputs: [RunAgentInput] {
        lock.lock()
        defer { lock.unlock() }
        return _inputs
    }

    /// Events yielded by the mock `run(input:)`.
    var mockEvents: [any AGUIEvent] = []

    override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        lock.lock()
        _inputs.append(input)
        lock.unlock()

        let events = mockEvents
        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }
}

// MARK: - Mock ToolRegistry

private actor MockToolRegistry: ToolRegistry {
    private let tools: [Tool]

    init(tools: [Tool]) {
        self.tools = tools
    }

    func allTools() async -> [Tool] { tools }

    func register(executor: any ToolExecutor) async throws {}

    func unregister(toolName: String) async -> Bool { false }

    func executor(for toolName: String) async -> (any ToolExecutor)? { nil }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(success: false, message: "mock")
    }

    func isToolRegistered(toolName: String) async -> Bool { false }

    func stats(for toolName: String) async -> ToolExecutionStats? { nil }

    func getAllStats() async -> [String: ToolExecutionStats] { [:] }

    func clearStats() async {}

    func getAllExecutors() async -> [String: any ToolExecutor] { [:] }
}

// MARK: - AgUiAgentTests

final class AgUiAgentTests: XCTestCase {

    private let agentURL = URL(string: "https://agent.example.com")!

    // MARK: - sendMessage constructs correct RunAgentInput

    func testSendMessageProducesUserMessage() async throws {
        let agent = CapturingAgent(url: agentURL)
        let stream = agent.sendMessage("Hello!")
        for try await _ in stream {}

        let inputs = agent.capturedInputs
        XCTAssertEqual(inputs.count, 1)

        let input = try XCTUnwrap(inputs.first)
        // Only user message (no system prompt configured)
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].role, .user)
        XCTAssertEqual(input.messages[0].content, "Hello!")
    }

    func testSendMessagePrependsSystemPromptWhenConfigured() async throws {
        let agent = CapturingAgent(url: agentURL) { config in
            config.systemPrompt = "Be concise."
        }
        let stream = agent.sendMessage("Hi", includeSystemPrompt: true)
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].role, .system)
        XCTAssertEqual(input.messages[0].content, "Be concise.")
        XCTAssertEqual(input.messages[1].role, .user)
    }

    func testSendMessageOmitsSystemPromptWhenDisabled() async throws {
        let agent = CapturingAgent(url: agentURL) { config in
            config.systemPrompt = "Be concise."
        }
        let stream = agent.sendMessage("Hi", includeSystemPrompt: false)
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.messages[0].role, .user)
    }

    func testSendMessageUsesProvidedThreadId() async throws {
        let agent = CapturingAgent(url: agentURL)
        let stream = agent.sendMessage("Hello", threadId: "my-thread")
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.threadId, "my-thread")
    }

    func testSendMessageUsesProvidedState() async throws {
        let customState = Data("{\"mode\":\"test\"}".utf8)
        let agent = CapturingAgent(url: agentURL)
        let stream = agent.sendMessage("Hello", state: customState)
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.state, customState)
    }

    func testSendMessageEachCallIsFreshNoHistory() async throws {
        let agent = CapturingAgent(url: agentURL)

        // First call
        for try await _ in agent.sendMessage("Message 1") {}
        // Second call
        for try await _ in agent.sendMessage("Message 2") {}

        XCTAssertEqual(agent.capturedInputs.count, 2)

        // Each call should only contain its own user message
        let first = agent.capturedInputs[0]
        let second = agent.capturedInputs[1]

        XCTAssertEqual(first.messages.count, 1)
        XCTAssertEqual(first.messages[0].content, "Message 1")

        XCTAssertEqual(second.messages.count, 1)
        XCTAssertEqual(second.messages[0].content, "Message 2")
    }

    // MARK: - Tool registry integration

    func testSendMessageIncludesToolsFromRegistry() async throws {
        let tool1 = Tool(name: "get_weather", description: "Get weather", parameters: Data("{}".utf8))
        let tool2 = Tool(name: "search_web", description: "Search the web", parameters: Data("{}".utf8))
        let registry = MockToolRegistry(tools: [tool1, tool2])

        let agent = CapturingAgent(url: agentURL) { config in
            config.toolRegistry = registry
        }

        let stream = agent.sendMessage("What's the weather?")
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.tools.count, 2)
        XCTAssertEqual(input.tools[0].name, "get_weather")
        XCTAssertEqual(input.tools[1].name, "search_web")
    }

    func testSendMessageHasEmptyToolsWhenNoRegistry() async throws {
        let agent = CapturingAgent(url: agentURL)
        let stream = agent.sendMessage("Hello")
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertTrue(input.tools.isEmpty)
    }

    // MARK: - Context passthrough

    func testSendMessageIncludesContext() async throws {
        let ctx = Context(description: "timezone", value: "America/New_York")
        let agent = CapturingAgent(url: agentURL) { config in
            config.context = [ctx]
        }
        let stream = agent.sendMessage("What time is it?")
        for try await _ in stream {}

        let input = try XCTUnwrap(agent.capturedInputs.first)
        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.context[0].description, "timezone")
    }

    // MARK: - Event passthrough

    func testSendMessageYieldsEventsFromRun() async throws {
        let agentURL = URL(string: "https://agent.example.com")!
        let agent = CapturingAgent(url: agentURL)
        agent.mockEvents = [
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ]

        var received: [any AGUIEvent] = []
        for try await event in agent.sendMessage("Hi") {
            received.append(event)
        }

        XCTAssertEqual(received.count, 2)
        XCTAssertTrue(received[0] is RunStartedEvent)
        XCTAssertTrue(received[1] is RunFinishedEvent)
    }

    // MARK: - close()

    func testCloseDoesNotCrash() {
        let agent = AgUiAgent(url: agentURL)
        // Verify close() completes without throwing or crashing
        agent.close()
    }

    func testCloseCanBeCalledMultipleTimes() {
        let agent = AgUiAgent(url: agentURL)
        agent.close()
        agent.close() // second call must not crash
    }
}
