package com.agui.tools

import com.agui.core.types.FunctionCall
import com.agui.core.types.ToolCall
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest

class ToolErrorHandlerTest {

    private fun context(toolName: String = "calculator") = ToolExecutionContext(
        toolCall = ToolCall(
            id = "call-1",
            function = FunctionCall(
                name = toolName,
                arguments = """{"value":42}"""
            )
        )
    )

    @Test
    fun retryableErrorsReturnRetryDecision() = runTest {
        val handler = ToolErrorHandler(
            ToolErrorConfig(
                maxRetryAttempts = 3,
                baseRetryDelayMs = 100,
                retryStrategy = RetryStrategy.FIXED,
                circuitBreakerConfig = CircuitBreakerConfig(failureThreshold = 3, recoveryTimeoutMs = 100, successThreshold = 1)
            )
        )

        val decision = handler.handleError(
            error = ToolTimeoutException("timeout"),
            context = context(),
            attempt = 1
        )

        val retry = assertIs<ToolErrorDecision.Retry>(decision)
        assertEquals(100, retry.delayMs)
        assertEquals(3, retry.maxAttempts)
    }

    @Test
    fun exponentialBackoffIsCappedAtConfiguredMaximum() = runTest {
        val handler = ToolErrorHandler(
            ToolErrorConfig(
                maxRetryAttempts = 5,
                baseRetryDelayMs = 50,
                maxRetryDelayMs = 120,
                retryStrategy = RetryStrategy.EXPONENTIAL,
                circuitBreakerConfig = CircuitBreakerConfig(failureThreshold = 4, recoveryTimeoutMs = 100, successThreshold = 1)
            )
        )

        val decision = handler.handleError(
            error = ToolNetworkException("network blip"),
            context = context(),
            attempt = 3
        )

        val retry = assertIs<ToolErrorDecision.Retry>(decision)
        assertEquals(120, retry.delayMs) // capped at maxRetryDelayMs
    }

    @Test
    fun nonRetryableFailuresOpenCircuitAndReportStats() = runTest {
        val handler = ToolErrorHandler(
            ToolErrorConfig(
                maxRetryAttempts = 2,
                retryStrategy = RetryStrategy.FIXED,
                circuitBreakerConfig = CircuitBreakerConfig(
                    failureThreshold = 1,
                    recoveryTimeoutMs = 60_000,
                    successThreshold = 1
                )
            )
        )

        val failDecision = handler.handleError(
            error = ToolValidationException("invalid arguments"),
            context = context(),
            attempt = 1
        )

        val fail = assertIs<ToolErrorDecision.Fail>(failDecision)
        assertTrue(fail.message.contains("invalid"))
        assertTrue(fail.shouldReport.not())

        val stats = handler.getErrorStats("calculator")
        assertEquals(1, stats.totalAttempts)
        assertEquals(CircuitBreakerState.OPEN, stats.circuitBreakerState)

        val secondDecision = handler.handleError(
            error = ToolValidationException("still invalid"),
            context = context(),
            attempt = 1
        )

        val secondFail = assertIs<ToolErrorDecision.Fail>(secondDecision)
        assertTrue(
            secondFail.message.contains("temporarily unavailable"),
            "Unexpected message: ${secondFail.message}"
        )

        handler.recordSuccess("calculator")
        val resetStats = handler.getErrorStats("calculator")
        assertEquals(CircuitBreakerState.CLOSED, resetStats.circuitBreakerState)
        assertEquals(0, resetStats.totalAttempts)
    }
}
