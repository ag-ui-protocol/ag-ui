import AGUICore
@testable import AGUIClient
import XCTest

final class ClientReviewRegressionTests: XCTestCase {
    private func apply(_ events: [any AGUIEvent], messages: [any Message] = [],
                       state: Data = Data("{}".utf8)) async throws -> AgentState {
        let input = RunAgentInput(threadId: "thread", runId: "run", state: state, messages: messages)
        let stream = AsyncThrowingStream<any AGUIEvent, Error> { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
        var result = AgentState(messages: messages, state: state)
        for try await update in stream.applyEvents(input: input) {
            if let messages = update.messages { result.messages = messages }
            if let state = update.state { result.state = state }
        }
        return result
    }

    func testExplicitMissingParentDoesNotAttachToPreviousAssistant() async throws {
        let result = try await apply([
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search", parentMessageId: "new")
        ], messages: [AssistantMessage(id: "old", content: "Previous turn")])
        XCTAssertEqual(result.messages?.map(\.id), ["old", "new"])
        XCTAssertNil((result.messages?.first as? AssistantMessage)?.toolCalls)
    }

    func testAbsentAndCollidingParentsCreateTheirOwnAssistant() async throws {
        let result = try await apply([
            ToolCallStartEvent(toolCallId: "first", toolCallName: "search"),
            ToolCallStartEvent(toolCallId: "second", toolCallName: "search", parentMessageId: "user")
        ], messages: [AssistantMessage(id: "old"), UserMessage(id: "user", content: "Hello")])
        XCTAssertEqual(result.messages?.map(\.id), ["old", "user", "first", "second"])
    }

    func testDuplicateToolStartPreservesArgumentsAndDoesNotCreateParent() async throws {
        let result = try await apply([
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search", parentMessageId: "parent"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{}"),
            ToolCallStartEvent(toolCallId: "call", toolCallName: "renamed", parentMessageId: "stray")
        ])
        XCTAssertEqual(result.messages?.count, 1)
        let calls = (result.messages?.first as? AssistantMessage)?.toolCalls
        XCTAssertEqual(calls?.count, 1)
        XCTAssertEqual(calls?.first?.function.arguments, "{}")
        XCTAssertEqual(calls?.first?.function.name, "renamed")
    }

    func testReplayedHistoryArgumentsReplaceRatherThanAppend() async throws {
        let previous = AssistantMessage(id: "parent", toolCalls: [
            ToolCall(id: "call", function: FunctionCall(name: "search", arguments: "{\"old\":1}"))
        ])
        let result = try await apply([
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{\"new\":"),
            ToolCallArgsEvent(toolCallId: "call", delta: "2}")
        ], messages: [previous])
        XCTAssertEqual((result.messages?.first as? AssistantMessage)?.toolCalls?.first?.function.arguments,
                       "{\"new\":2}")
    }

    func testCompletedToolCallCanReplayArgumentsInSameStream() async throws {
        let result = try await apply([
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{\"old\":1}"),
            ToolCallEndEvent(toolCallId: "call"),
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{\"new\":2}"),
            ToolCallEndEvent(toolCallId: "call")
        ])
        XCTAssertEqual((result.messages?.first as? AssistantMessage)?.toolCalls?.first?.function.arguments,
                       "{\"new\":2}")
    }

    func testRunStartedResetsToolReplayTracking() async throws {
        let result = try await apply([
            RunStartedEvent(threadId: "thread", runId: "first"),
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{\"old\":1}"),
            RunStartedEvent(threadId: "thread", runId: "second"),
            ToolCallStartEvent(toolCallId: "call", toolCallName: "search"),
            ToolCallArgsEvent(toolCallId: "call", delta: "{\"new\":2}")
        ])
        XCTAssertEqual((result.messages?.first as? AssistantMessage)?.toolCalls?.first?.function.arguments,
                       "{\"new\":2}")
    }

    func testMixedTextContentAndChunkPreserveUserRole() async throws {
        let input = RunAgentInput(threadId: "thread", runId: "run")
        let events: [any AGUIEvent] = [
            RunStartedEvent(threadId: "thread", runId: "run"),
            TextMessageStartEvent(messageId: "user", role: "user"),
            TextMessageContentEvent(messageId: "user", delta: "Hello"),
            TextMessageChunkEvent(messageId: "user", role: "user", delta: " world"),
            TextMessageEndEvent(messageId: "user"),
            RunFinishedEvent(threadId: "thread", runId: "run")
        ]
        let stream = AsyncThrowingStream<any AGUIEvent, Error> { continuation in
            for event in events { continuation.yield(event) }
            continuation.finish()
        }
        var messages: [any Message] = []
        for try await update in stream.transformChunks().verifyEvents().applyEvents(input: input) {
            if let updated = update.messages { messages = updated }
        }
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual((messages.first as? UserMessage)?.content, "Hello world")
    }

    func testToolResultsPrecedeTrailingTextAndCorrectionsUpdateInPlace() async throws {
        let parent = AssistantMessage(id: "parent", toolCalls: [
            ToolCall(id: "call", function: FunctionCall(name: "search", arguments: "{}"))
        ])
        let result = try await apply([
            ToolCallResultEvent(messageId: "result", toolCallId: "call", content: "first"),
            ToolCallResultEvent(messageId: "result", toolCallId: "call", content: "corrected")
        ], messages: [parent, AssistantMessage(id: "trailing", content: "Done")])
        XCTAssertEqual(result.messages?.map(\.id), ["parent", "result", "trailing"])
        XCTAssertEqual((result.messages?[1] as? ToolMessage)?.content, "corrected")
    }

    func testReusedCallIdSelectsUnansweredOwnerAndPreservesParallelResultOrder() async throws {
        func parent(_ id: String) -> AssistantMessage {
            AssistantMessage(id: id, toolCalls: [
                ToolCall(id: "call", function: FunctionCall(name: "search", arguments: "{}")),
                ToolCall(id: "parallel", function: FunctionCall(name: "lookup", arguments: "{}"))
            ])
        }
        let result = try await apply([
            ToolCallResultEvent(messageId: "new-result", toolCallId: "call", content: "new"),
            ToolCallResultEvent(messageId: "parallel-result", toolCallId: "parallel", content: "parallel")
        ], messages: [
            parent("old"), ToolMessage(id: "old-result", content: "old", toolCallId: "call"),
            parent("new"), AssistantMessage(id: "trailing", content: "Done")
        ])
        XCTAssertEqual(result.messages?.map(\.id),
                       ["old", "old-result", "new", "new-result", "parallel-result", "trailing"])
    }

    func testStreamedUserRoleAndContentArePreserved() async throws {
        let result = try await apply([
            TextMessageStartEvent(messageId: "user", role: "user"),
            TextMessageContentEvent(messageId: "user", delta: "Hello"),
            TextMessageContentEvent(messageId: "user", delta: " world")
        ])
        XCTAssertEqual((result.messages?.first as? UserMessage)?.content, "Hello world")
    }

    func testMalformedStateDeltaDoesNotTerminateLaterEvents() async throws {
        let result = try await apply([
            StateDeltaEvent(delta: Data("not json".utf8)),
            StateDeltaEvent(delta: Data("{}".utf8)),
            StateDeltaEvent(delta: Data("[{\"op\":\"add\",\"path\":\"/valid\",\"value\":true}]".utf8))
        ])
        XCTAssertEqual(try JSONSerialization.jsonObject(with: XCTUnwrap(result.state)) as? [String: Bool],
                       ["valid": true])
    }

    func testParameterRunRetainsExplicitThreadHistoryAndState() async throws {
        let agent = AbstractAgent(transport: EmptyTransport())
        let state = Data("{\"count\":2}".utf8)
        try await agent.runAgent(input: RunAgentInput(threadId: "custom", runId: "first",
            state: state, messages: [UserMessage(id: "history", content: "Hello")]))
        let next = await agent.buildInput(from: RunAgentParameters(runId: "second"))
        XCTAssertEqual(next.threadId, "custom")
        XCTAssertEqual(next.messages.map(\.id), ["history"])
        XCTAssertEqual(next.state, state)
        let another = AbstractAgent(transport: EmptyTransport())
        let separate = await another.buildInput(from: nil)
        XCTAssertNotEqual(next.threadId, separate.threadId)
    }

    func testAbortRunCancelsUnderlyingTransport() async throws {
        let started = expectation(description: "transport started")
        let cancelled = expectation(description: "transport cancelled")
        let agent = AbstractAgent(transport: WaitingTransport(started: started, cancelled: cancelled))
        let task = Task { try await agent.runAgent() }
        await fulfillment(of: [started], timeout: 2)
        await agent.abortRun()
        await fulfillment(of: [cancelled], timeout: 2)
        _ = await task.result
    }
    func testCancellingCallerCancelsUnderlyingTransport() async throws {
        let started = expectation(description: "transport started")
        let cancelled = expectation(description: "transport cancelled")
        let agent = AbstractAgent(transport: WaitingTransport(started: started, cancelled: cancelled))
        let task = Task { try await agent.runAgent() }
        await fulfillment(of: [started], timeout: 2)
        task.cancel()
        await fulfillment(of: [cancelled], timeout: 2)
        _ = await task.result
    }

    func testDisposeCancelsUnderlyingTransport() async throws {
        let started = expectation(description: "transport started")
        let cancelled = expectation(description: "transport cancelled")
        let agent = AbstractAgent(transport: WaitingTransport(started: started, cancelled: cancelled))
        let task = Task { try await agent.runAgent() }
        await fulfillment(of: [started], timeout: 2)
        await agent.dispose()
        await fulfillment(of: [cancelled], timeout: 2)
        _ = await task.result
    }

}

private struct EmptyTransport: AgentTransport {
    func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private struct WaitingTransport: AgentTransport {
    let started: XCTestExpectation
    let cancelled: XCTestExpectation
    func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            continuation.onTermination = { reason in
                if case .cancelled = reason { cancelled.fulfill() }
            }
            continuation.yield(RunStartedEvent(threadId: input.threadId, runId: input.runId))
            started.fulfill()
        }
    }
}
