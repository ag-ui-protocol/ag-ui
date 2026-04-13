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

import AGUIClient
import AGUICore
import AGUITools
import XCTest
@testable import AGUIAgentSDK

// MARK: - MockAbstractAgent

/// `AbstractAgent` subclass that emits a preset sequence of events.
///
/// Each call to `run(input:)` pops the next event sequence from `eventSequences`.
/// When the queue is empty, subsequent calls emit an empty stream.
private final class MockAbstractAgent: AbstractAgent, @unchecked Sendable {
    private let lock = NSLock()
    private var _eventSequences: [[any AGUIEvent]] = []

    /// Enqueue event sequences to be emitted on successive `run(input:)` calls.
    func enqueue(_ events: [any AGUIEvent]) {
        lock.lock()
        _eventSequences.append(events)
        lock.unlock()
    }

    override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        lock.lock()
        let events: [any AGUIEvent] = _eventSequences.isEmpty ? [] : _eventSequences.removeFirst()
        lock.unlock()

        return AsyncThrowingStream { continuation in
            for event in events {
                continuation.yield(event)
            }
            continuation.finish()
        }
    }
}

// MARK: - EndToEndPipelineTests

final class EndToEndPipelineTests: XCTestCase {

    // MARK: - Text-only conversation

    /// Full text-message pipeline: events accumulate into an `AssistantMessage` in `agent.messages`.
    func testTextOnlyConversationBuildsMessages() async throws {
        let agent = MockAbstractAgent()
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            TextMessageStartEvent(messageId: "msg1"),
            TextMessageContentEvent(messageId: "msg1", delta: "Hello"),
            TextMessageContentEvent(messageId: "msg1", delta: ", world!"),
            TextMessageEndEvent(messageId: "msg1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let messages = await agent.messages
        XCTAssertEqual(messages.count, 1)
        let assistantMsg = try XCTUnwrap(messages.first as? AssistantMessage)
        XCTAssertEqual(assistantMsg.id, "msg1")
        XCTAssertEqual(assistantMsg.content, "Hello, world!")
    }

    // MARK: - State snapshot & delta

    /// `STATE_SNAPSHOT` sets initial state; `STATE_DELTA` patches it.
    func testStateDeltaIsAppliedCorrectly() async throws {
        let agent = MockAbstractAgent()

        // Initial state: {"count": 0}
        let initialJSON = Data("{\"count\":0}".utf8)
        // Delta: [{"op":"replace","path":"/count","value":5}]
        let patchJSON = Data("[{\"op\":\"replace\",\"path\":\"/count\",\"value\":5}]".utf8)

        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: initialJSON),
            StateDeltaEvent(delta: patchJSON),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let finalState = await agent.state
        guard let json = try? JSONSerialization.jsonObject(with: finalState) as? [String: Any],
              let count = json["count"] as? Int else {
            XCTFail("Could not parse final state")
            return
        }
        XCTAssertEqual(count, 5)
    }

    func testStateSnapshotReplacesState() async throws {
        let agent = MockAbstractAgent()
        let snapshotJSON = Data("{\"mode\":\"creative\"}".utf8)

        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: snapshotJSON),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let state = await agent.state
        guard let json = try? JSONSerialization.jsonObject(with: state) as? [String: Any],
              let mode = json["mode"] as? String else {
            XCTFail("Could not parse state")
            return
        }
        XCTAssertEqual(mode, "creative")
    }

    // MARK: - Thinking telemetry

    /// Full thinking sequence builds `ThinkingTelemetryState`.
    func testThinkingSequenceBuildsThinkingState() async throws {
        let agent = MockAbstractAgent()
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ThinkingStartEvent(title: "Step 1"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta: "I am thinking..."),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let thinking = await agent.thinking
        let state = try XCTUnwrap(thinking)
        XCTAssertFalse(state.isThinking, "Thinking should be finished after ThinkingEndEvent")
        XCTAssertEqual(state.title, "Step 1")
        XCTAssertTrue(state.messages.contains("I am thinking..."))
    }

    func testRunStartedResetsThinkingState() async throws {
        let agent = MockAbstractAgent()

        // First run leaves thinking state
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ThinkingStartEvent(),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta: "old thought"),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        // Second run: thinking state should be reset on RUN_STARTED
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r2"),
            RunFinishedEvent(threadId: "t1", runId: "r2"),
        ])

        try await agent.runAgent()

        let thinking = await agent.thinking
        XCTAssertNotNil(thinking) // was set by first run
    }

    // MARK: - Sequential multi-run (state persists)

    func testSequentialRunsMaintainState() async throws {
        let agent = MockAbstractAgent()

        let state1 = Data("{\"turn\":1}".utf8)
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            StateSnapshotEvent(snapshot: state1),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let stateAfterRun1 = await agent.state
        guard let json1 = try? JSONSerialization.jsonObject(with: stateAfterRun1) as? [String: Any],
              let turn1 = json1["turn"] as? Int else {
            XCTFail("Could not parse state after run 1")
            return
        }
        XCTAssertEqual(turn1, 1)

        let state2 = Data("{\"turn\":2}".utf8)
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r2"),
            StateSnapshotEvent(snapshot: state2),
            RunFinishedEvent(threadId: "t1", runId: "r2"),
        ])

        try await agent.runAgent()

        let stateAfterRun2 = await agent.state
        guard let json2 = try? JSONSerialization.jsonObject(with: stateAfterRun2) as? [String: Any],
              let turn2 = json2["turn"] as? Int else {
            XCTFail("Could not parse state after run 2")
            return
        }
        XCTAssertEqual(turn2, 2)
    }

    // MARK: - Invalid event stream — EventVerifier

    /// A stream that starts with a non-RUN_STARTED event must throw `AGUIProtocolError`.
    func testInvalidEventStreamThrowsProtocolError() async throws {
        let agent = MockAbstractAgent()

        // Intentionally wrong: TextMessageStart without RUN_STARTED
        agent.enqueue([
            TextMessageStartEvent(messageId: "msg1"),
        ])

        do {
            try await agent.runAgent()
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertFalse(error.message.isEmpty)
        } catch {
            XCTFail("Expected AGUIProtocolError, got \(type(of: error)): \(error)")
        }
    }

    func testRunAfterRunErrorThrows() async throws {
        let agent = MockAbstractAgent()

        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RunErrorEvent(
                threadId: "t1",
                runId: "r1",
                error: RunErrorEvent.ErrorInfo(code: "FATAL", message: "fatal error")
            ),
            // Any event after RUN_ERROR should cause a protocol error
            TextMessageStartEvent(messageId: "msg1"),
        ])

        do {
            try await agent.runAgent()
            XCTFail("Expected AGUIProtocolError to be thrown")
        } catch let error as AGUIProtocolError {
            XCTAssertTrue(error.message.contains("errored"))
        } catch {
            XCTFail("Expected AGUIProtocolError, got \(type(of: error)): \(error)")
        }
    }

    // MARK: - Tool call accumulation

    /// Tool call events (START/ARGS/END) build an `AssistantMessage` with `toolCalls`.
    func testToolCallSequenceBuildsAssistantMessageWithToolCalls() async throws {
        let agent = MockAbstractAgent()
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            ToolCallStartEvent(toolCallId: "tc1", toolCallName: "get_weather"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "{\"city\":"),
            ToolCallArgsEvent(toolCallId: "tc1", delta: "\"London\"}"),
            ToolCallEndEvent(toolCallId: "tc1"),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let messages = await agent.messages
        XCTAssertFalse(messages.isEmpty)

        let assistantMsg = messages.compactMap { $0 as? AssistantMessage }.first
        let msg = try XCTUnwrap(assistantMsg)
        let calls = try XCTUnwrap(msg.toolCalls)
        XCTAssertFalse(calls.isEmpty)

        let call = try XCTUnwrap(calls.first)
        XCTAssertEqual(call.id, "tc1")
        XCTAssertEqual(call.function.name, "get_weather")
        XCTAssertEqual(call.function.arguments, "{\"city\":\"London\"}")
    }

    // MARK: - Custom & raw events

    func testRawEventsAccumulate() async throws {
        let agent = MockAbstractAgent()
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            RawEvent(data: Data("{\"event\":\"raw_1\"}".utf8)),
            RawEvent(data: Data("{\"event\":\"raw_2\"}".utf8)),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let rawEvents = await agent.rawEvents
        XCTAssertEqual(rawEvents.count, 2)
    }

    func testCustomEventsAccumulate() async throws {
        let agent = MockAbstractAgent()
        agent.enqueue([
            RunStartedEvent(threadId: "t1", runId: "r1"),
            CustomEvent(customType: "ping", data: Data("{\"ts\":1}".utf8)),
            CustomEvent(customType: "pong", data: Data("{\"ts\":2}".utf8)),
            RunFinishedEvent(threadId: "t1", runId: "r1"),
        ])

        try await agent.runAgent()

        let customEvents = await agent.customEvents
        XCTAssertEqual(customEvents.count, 2)
        XCTAssertEqual(customEvents[0].customType, "ping")
        XCTAssertEqual(customEvents[1].customType, "pong")
    }

    // MARK: - getAllExecutors()

    func testDefaultToolRegistryGetAllExecutors() async throws {
        let registry = DefaultToolRegistry()

        let executor = SimpleMockExecutor(toolName: "search", description: "Search")
        try await registry.register(executor: executor)

        let executors = await registry.getAllExecutors()
        XCTAssertEqual(executors.count, 1)
        XCTAssertNotNil(executors["search"])
    }

    func testGetAllExecutorsReturnsEmptyWhenNoTools() async {
        let registry = DefaultToolRegistry()
        let executors = await registry.getAllExecutors()
        XCTAssertTrue(executors.isEmpty)
    }

    func testGetAllExecutorsAfterUnregister() async throws {
        let registry = DefaultToolRegistry()
        let executor = SimpleMockExecutor(toolName: "tool_a", description: "A")
        try await registry.register(executor: executor)
        _ = await registry.unregister(toolName: "tool_a")

        let executors = await registry.getAllExecutors()
        XCTAssertTrue(executors.isEmpty)
    }
}

// MARK: - SimpleMockExecutor

private final class SimpleMockExecutor: ToolExecutor, @unchecked Sendable {
    let tool: Tool

    init(toolName: String, description: String) {
        self.tool = Tool(
            name: toolName,
            description: description,
            parameters: Data("{}".utf8)
        )
    }

    func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
        ToolExecutionResult(success: true, result: Data("ok".utf8))
    }

    func getMaxExecutionTimeMs() -> Int64? { nil }
}
