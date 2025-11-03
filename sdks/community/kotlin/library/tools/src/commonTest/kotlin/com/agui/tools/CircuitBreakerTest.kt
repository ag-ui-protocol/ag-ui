package com.agui.tools

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking

class CircuitBreakerTest {

    private val config = CircuitBreakerConfig(
        failureThreshold = 2,
        recoveryTimeoutMs = 20,
        successThreshold = 2
    )

    private val breaker = CircuitBreaker(config)

    @AfterTest
    fun cleanup() {
        breaker.reset()
    }

    @Test
    fun opensAfterConfiguredFailures() {
        breaker.recordFailure()
        assertFalse(breaker.isOpen())

        breaker.recordFailure()
        assertTrue(breaker.isOpen())
        assertEquals(CircuitBreakerState.OPEN, breaker.getState())
    }

    @Test
    fun transitionsToHalfOpenAfterTimeoutAndClosesOnSuccess() = runBlocking {
        breaker.recordFailure()
        breaker.recordFailure()
        assertTrue(breaker.isOpen())

        delay(25)
        assertFalse(breaker.isOpen())
        assertEquals(CircuitBreakerState.HALF_OPEN, breaker.getState())

        breaker.recordSuccess()
        assertEquals(CircuitBreakerState.HALF_OPEN, breaker.getState())

        breaker.recordSuccess()
        assertEquals(CircuitBreakerState.CLOSED, breaker.getState())
        assertFalse(breaker.isOpen())
    }

    @Test
    fun failureDuringHalfOpenReopensCircuit() = runBlocking {
        breaker.recordFailure()
        breaker.recordFailure()
        delay(25)
        assertFalse(breaker.isOpen()) // transitions to half-open

        breaker.recordFailure()
        assertTrue(breaker.isOpen())
        assertEquals(CircuitBreakerState.OPEN, breaker.getState())
    }
}
