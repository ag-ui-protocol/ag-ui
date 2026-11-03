// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUITools
@testable import AGUICore

// MARK: - Helpers

private func makeContext(toolName: String = "calculator") -> ToolExecutionContext {
    ToolExecutionContext(
        toolCall: ToolCall(
            id: "call_1",
            function: FunctionCall(name: toolName, arguments: "{}")
        )
    )
}

private struct TransientError: Error {}

// MARK: - CircuitBreakerTests

final class CircuitBreakerTests: XCTestCase {

    // MARK: Closed state

    func test_allowsRequests_whenClosed() async {
        let cb = CircuitBreaker()
        let allowed = await cb.allowRequest()
        XCTAssertTrue(allowed)
    }

    func test_staysClosed_belowFailureThreshold() async {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(failureThreshold: 3))
        await cb.recordFailure()
        await cb.recordFailure()
        let state = await cb.currentState()
        let allowed = await cb.allowRequest()
        XCTAssertEqual(state, .closed)
        XCTAssertTrue(allowed)
    }

    func test_opensCircuit_whenFailureThresholdReached() async {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(failureThreshold: 2))
        await cb.recordFailure()
        await cb.recordFailure()
        let state = await cb.currentState()
        let allowed = await cb.allowRequest()
        XCTAssertEqual(state, .open)
        XCTAssertFalse(allowed)
    }

    func test_resetsFailureCount_onSuccessWhileClosed() async {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(failureThreshold: 3))
        await cb.recordFailure()
        await cb.recordFailure()
        await cb.recordSuccess()
        // Needs 3 more failures to open
        await cb.recordFailure()
        await cb.recordFailure()
        let state = await cb.currentState()
        XCTAssertEqual(state, .closed)
    }

    // MARK: Open state

    func test_blocksAllRequests_whenOpen() async {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(failureThreshold: 1))
        await cb.recordFailure()
        let first = await cb.allowRequest()
        let second = await cb.allowRequest()
        XCTAssertFalse(first)
        XCTAssertFalse(second)
    }

    func test_transitionsToHalfOpen_afterRecoveryTimeout() async throws {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(
            failureThreshold: 1,
            recoveryTimeoutSeconds: 0.05
        ))
        await cb.recordFailure()
        let blockedBefore = await cb.allowRequest()
        XCTAssertFalse(blockedBefore)

        try await Task.sleep(for: .milliseconds(60))

        let allowedAfter = await cb.allowRequest()
        let state = await cb.currentState()
        XCTAssertTrue(allowedAfter)
        XCTAssertEqual(state, .halfOpen)
    }

    // MARK: Half-open state

    func test_closesCircuit_afterSuccessThresholdInHalfOpen() async throws {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(
            failureThreshold: 1,
            recoveryTimeoutSeconds: 0.05,
            successThreshold: 2
        ))
        await cb.recordFailure()
        try await Task.sleep(for: .milliseconds(60))
        _ = await cb.allowRequest() // transitions to halfOpen

        await cb.recordSuccess()
        let midState = await cb.currentState()
        await cb.recordSuccess()
        let finalState = await cb.currentState()

        XCTAssertEqual(midState, .halfOpen)
        XCTAssertEqual(finalState, .closed)
    }

    func test_reopensCircuit_onFailureDuringHalfOpen() async throws {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(
            failureThreshold: 1,
            recoveryTimeoutSeconds: 0.05
        ))
        await cb.recordFailure()
        try await Task.sleep(for: .milliseconds(60))
        _ = await cb.allowRequest() // transitions to halfOpen
        let halfOpenState = await cb.currentState()
        XCTAssertEqual(halfOpenState, .halfOpen)

        await cb.recordFailure()
        let finalState = await cb.currentState()
        XCTAssertEqual(finalState, .open)
    }

    // MARK: Reset

    func test_reset_closesForcefully() async {
        let cb = CircuitBreaker(config: CircuitBreakerConfig(failureThreshold: 1))
        await cb.recordFailure()
        let openState = await cb.currentState()
        XCTAssertEqual(openState, .open)

        await cb.reset()
        let closedState = await cb.currentState()
        let allowed = await cb.allowRequest()
        XCTAssertEqual(closedState, .closed)
        XCTAssertTrue(allowed)
    }
}

// MARK: - ToolErrorHandlerTests

final class ToolErrorHandlerTests: XCTestCase {

    private let context = makeContext()

    // MARK: shouldAllowExecution

    func test_shouldAllowExecution_trueWhenClosed() async {
        let handler = ToolErrorHandler()
        let allowed = await handler.shouldAllowExecution()
        XCTAssertTrue(allowed)
    }

    func test_shouldAllowExecution_falseWhenCircuitOpen() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 1)
        ))
        _ = await handler.handleError(error: TransientError(), context: context, attempt: 0)
        let allowed = await handler.shouldAllowExecution()
        XCTAssertFalse(allowed)
    }

    func test_shouldAllowExecution_trueAfterRecovery() async throws {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(
                failureThreshold: 1,
                recoveryTimeoutSeconds: 0.05
            )
        ))
        _ = await handler.handleError(error: TransientError(), context: context, attempt: 0)
        let blockedBefore = await handler.shouldAllowExecution()
        XCTAssertFalse(blockedBefore)

        try await Task.sleep(for: .milliseconds(60))

        let allowedAfter = await handler.shouldAllowExecution()
        let state = await handler.circuitBreakerState()
        XCTAssertTrue(allowedAfter)
        XCTAssertEqual(state, .halfOpen)
    }

    // MARK: handleError — retry decisions

    func test_handleError_returnsRetry_forTransientError() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(maxRetryAttempts: 3))
        let decision = await handler.handleError(
            error: TransientError(),
            context: context,
            attempt: 0
        )
        guard case .retry = decision else {
            XCTFail("Expected .retry, got \(decision)")
            return
        }
    }

    func test_handleError_returnsFail_whenMaxAttemptsExceeded() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(maxRetryAttempts: 2))
        let decision = await handler.handleError(
            error: TransientError(),
            context: context,
            attempt: 2
        )
        guard case .fail = decision else {
            XCTFail("Expected .fail, got \(decision)")
            return
        }
    }

    func test_handleError_returnsFail_forNonRetryableValidationError() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(retryOnValidation: false))
        let decision = await handler.handleError(
            error: ToolExecutionError.validationFailed(message: "bad args"),
            context: context,
            attempt: 0
        )
        guard case .fail = decision else {
            XCTFail("Expected .fail, got \(decision)")
            return
        }
    }

    func test_handleError_returnsRetry_forValidationErrorWhenConfigured() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 3,
            retryOnValidation: true
        ))
        let decision = await handler.handleError(
            error: ToolExecutionError.validationFailed(message: "bad args"),
            context: context,
            attempt: 0
        )
        guard case .retry = decision else {
            XCTFail("Expected .retry, got \(decision)")
            return
        }
    }

    // MARK: handleError — circuit breaker integration

    func test_handleError_opensCircuit_afterFailureThreshold() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 10,
            circuitBreaker: CircuitBreakerConfig(failureThreshold: 3)
        ))
        for attempt in 0 ..< 3 {
            _ = await handler.handleError(error: TransientError(), context: context, attempt: attempt)
        }
        let state = await handler.circuitBreakerState()
        XCTAssertEqual(state, .open)
    }

    func test_recordSuccess_closesCircuit_afterRecovery() async throws {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 0,
            circuitBreaker: CircuitBreakerConfig(
                failureThreshold: 1,
                recoveryTimeoutSeconds: 0.05,
                successThreshold: 1
            )
        ))
        _ = await handler.handleError(error: TransientError(), context: context, attempt: 0)
        let openState = await handler.circuitBreakerState()
        XCTAssertEqual(openState, .open)

        try await Task.sleep(for: .milliseconds(60))
        _ = await handler.shouldAllowExecution() // transitions to halfOpen

        await handler.recordSuccess()
        let finalState = await handler.circuitBreakerState()
        XCTAssertEqual(finalState, .closed)
    }

    // MARK: Retry delay strategies

    func test_fixedStrategy_returnsConstantDelay() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 5,
            baseRetryDelayMs: 100,
            retryStrategy: .fixed
        ))
        var delays: [UInt64] = []
        for attempt in 0 ..< 3 {
            let decision = await handler.handleError(
                error: TransientError(), context: context, attempt: attempt
            )
            if case .retry(let ns) = decision {
                delays.append(ns)
            }
        }
        XCTAssertEqual(delays.count, 3)
        let expected: UInt64 = 100 * 1_000_000
        for delay in delays {
            XCTAssertEqual(delay, expected)
        }
    }

    func test_exponentialStrategy_doublesDelay() async {
        let handler = ToolErrorHandler(config: ToolErrorConfig(
            maxRetryAttempts: 5,
            baseRetryDelayMs: 100,
            maxRetryDelayMs: 10_000,
            retryStrategy: .exponential
        ))
        var delays: [UInt64] = []
        for attempt in 0 ..< 3 {
            let decision = await handler.handleError(
                error: TransientError(), context: context, attempt: attempt
            )
            if case .retry(let ns) = decision {
                delays.append(ns)
            }
        }
        // attempt 0 → 100ms, attempt 1 → 200ms, attempt 2 → 400ms
        XCTAssertEqual(delays[0], 100 * 1_000_000)
        XCTAssertEqual(delays[1], 200 * 1_000_000)
        XCTAssertEqual(delays[2], 400 * 1_000_000)
    }
}
