// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUITools
@testable import AGUICore

/// Integration tests that verify the circuit breaker works end-to-end through
/// ``DefaultToolRegistry/execute(context:)``.
final class CircuitBreakerIntegrationTests: XCTestCase {

    // MARK: - Helpers

    private let toolName = "weather"
    private struct NetworkError: Error {}

    private func makeTool(name: String? = nil) -> Tool {
        Tool(name: name ?? toolName, description: "Gets weather", parameters: Data("{}".utf8))
    }

    private func makeContext(name: String? = nil) -> ToolExecutionContext {
        ToolExecutionContext(
            toolCall: ToolCall(
                id: "call_1",
                function: FunctionCall(name: name ?? toolName, arguments: "{}")
            )
        )
    }

    // Executor that fails a configurable number of times then succeeds.
    actor CountingExecutor: ToolExecutor {
        let tool: Tool
        private(set) var callCount = 0
        private let failUntil: Int

        init(tool: Tool, failUntil: Int = Int.max) {
            self.tool = tool
            self.failUntil = failUntil
        }

        func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
            callCount += 1
            if callCount <= failUntil {
                throw NetworkError()
            }
            return ToolExecutionResult.success(message: "ok")
        }

        nonisolated func validate(toolCall: ToolCall) -> ToolValidationResult { .valid }
        nonisolated func maximumExecutionTime() -> Duration? { nil }
    }

    // MARK: - Circuit Breaker State Exposure

    func test_circuitBreakerState_isClosedForNewTool() async throws {
        let registry = DefaultToolRegistry()
        try await registry.register(executor: TestToolExecutor(tool: makeTool()))

        let state = await registry.circuitBreakerState(for: toolName)
        XCTAssertEqual(state, .closed)
    }

    func test_circuitBreakerState_isNilForUnregisteredTool() async {
        let registry = DefaultToolRegistry()
        let state = await registry.circuitBreakerState(for: "unknown")
        XCTAssertNil(state)
    }

    func test_circuitBreakerState_isRemovedOnUnregister() async throws {
        let registry = DefaultToolRegistry()
        try await registry.register(executor: TestToolExecutor(tool: makeTool()))
        _ = await registry.unregister(toolName: toolName)

        let state = await registry.circuitBreakerState(for: toolName)
        XCTAssertNil(state)
    }

    // MARK: - Circuit Breaker Opens After Failures

    func test_circuitOpens_afterFailureThreshold() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 3)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        let executor = CountingExecutor(tool: makeTool())
        try await registry.register(executor: executor)

        for _ in 0 ..< 3 {
            do { _ = try await registry.execute(context: makeContext()) } catch {}
        }

        let state = await registry.circuitBreakerState(for: toolName)
        XCTAssertEqual(state, .open)
    }

    // MARK: - Fast-Fail When Circuit Is Open

    func test_execute_throwsCircuitBreakerOpen_whenCircuitIsOpen() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 1)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        let executor = CountingExecutor(tool: makeTool())
        try await registry.register(executor: executor)

        // Trip the circuit
        do { _ = try await registry.execute(context: makeContext()) } catch {}
        let stateAfterTrip = await registry.circuitBreakerState(for: toolName)
        XCTAssertEqual(stateAfterTrip, .open)

        let callCountBeforeFastFail = await executor.callCount

        // Next call should fast-fail before reaching the executor
        do {
            _ = try await registry.execute(context: makeContext())
            XCTFail("Expected circuitBreakerOpen to be thrown")
        } catch let error as ToolExecutionError {
            guard case .circuitBreakerOpen(let name) = error else {
                XCTFail("Expected .circuitBreakerOpen, got \(error)")
                return
            }
            XCTAssertEqual(name, toolName)
        }

        let callCountAfterFastFail = await executor.callCount
        XCTAssertEqual(callCountAfterFastFail, callCountBeforeFastFail,
                       "Executor must not be called during circuit-open fast-fail")
    }

    // MARK: - Retry Logic

    func test_execute_retries_onTransientFailure_thenSucceeds() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 2,
            baseRetryDelayMs: 1,
            retryStrategy: .fixed,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 10)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        // Fails first 2 times, succeeds on 3rd
        let executor = CountingExecutor(tool: makeTool(), failUntil: 2)
        try await registry.register(executor: executor)

        let result = try await registry.execute(context: makeContext())
        let finalCallCount = await executor.callCount

        XCTAssertTrue(result.success)
        XCTAssertEqual(finalCallCount, 3)
    }

    func test_execute_throwsAfterExhaustingRetries() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 2,
            baseRetryDelayMs: 1,
            retryStrategy: .fixed,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 10)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        let executor = CountingExecutor(tool: makeTool()) // always fails
        try await registry.register(executor: executor)

        do {
            _ = try await registry.execute(context: makeContext())
            XCTFail("Expected an error to be thrown")
        } catch {
            // Expected — verify the executor was called initial + 2 retries = 3 times
            let callCount = await executor.callCount
            XCTAssertEqual(callCount, 3)
        }
    }

    // MARK: - Recovery After Timeout

    func test_execute_recovers_afterCircuitOpenTimeout() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(
                failureThreshold: 1,
                recoveryTimeoutSeconds: 0.05,
                successThreshold: 1
            )
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        // Fails once then succeeds
        let executor = CountingExecutor(tool: makeTool(), failUntil: 1)
        try await registry.register(executor: executor)

        // Open the circuit
        do { _ = try await registry.execute(context: makeContext()) } catch {}
        let openState = await registry.circuitBreakerState(for: toolName)
        XCTAssertEqual(openState, .open)

        // Confirm fast-fail while open
        do {
            _ = try await registry.execute(context: makeContext())
            XCTFail("Expected circuitBreakerOpen")
        } catch is ToolExecutionError {}

        // Wait for recovery window
        try await Task.sleep(for: .milliseconds(60))

        // Probe should succeed and close the circuit
        let result = try await registry.execute(context: makeContext())
        XCTAssertTrue(result.success)
        let recoveredState = await registry.circuitBreakerState(for: toolName)
        XCTAssertEqual(recoveredState, .closed)
    }

    // MARK: - Per-Tool Isolation

    func test_circuitBreaker_isIsolatedPerTool() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 1)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)

        let alwaysFails = CountingExecutor(tool: makeTool(name: "failing"))
        let alwaysWorks = CountingExecutor(tool: makeTool(name: "working"), failUntil: 0)
        try await registry.register(executor: alwaysFails)
        try await registry.register(executor: alwaysWorks)

        // Open the failing tool's circuit
        do { _ = try await registry.execute(context: makeContext(name: "failing")) } catch {}
        let failingState = await registry.circuitBreakerState(for: "failing")
        XCTAssertEqual(failingState, .open)

        // Working tool should still execute normally
        let result = try await registry.execute(context: makeContext(name: "working"))
        XCTAssertTrue(result.success)
        let workingState = await registry.circuitBreakerState(for: "working")
        XCTAssertEqual(workingState, .closed)
    }

    // MARK: - Stats Accuracy Under Retries

    func test_stats_countEachAttemptIndividually() async throws {
        let config = ToolErrorConfig(
            maxRetryAttempts: 2,
            baseRetryDelayMs: 1,
            retryStrategy: .fixed,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 10)
        )
        let registry = DefaultToolRegistry(errorHandlerConfig: config)
        let executor = CountingExecutor(tool: makeTool()) // always fails
        try await registry.register(executor: executor)

        do { _ = try await registry.execute(context: makeContext()) } catch {}

        let stats = await registry.stats(for: toolName)
        XCTAssertNotNil(stats)
        // Initial attempt + 2 retries = 3 failures recorded
        XCTAssertEqual(stats?.failureCount, 3)
        XCTAssertEqual(stats?.successCount, 0)
    }
}
