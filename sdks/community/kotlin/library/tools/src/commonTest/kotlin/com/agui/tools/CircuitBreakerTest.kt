package com.agui.tools

import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

class CircuitBreakerTest {

    private class TestClock(private var now: Instant) : Clock {
        override fun now(): Instant = now

        fun advanceBy(duration: Duration) {
            now += duration
        }
    }

    private val config = CircuitBreakerConfig(
        failureThreshold = 2,
        recoveryTimeoutMs = 20,
        successThreshold = 2
    )

    private val clock = TestClock(Instant.fromEpochMilliseconds(1_000_000))

    private val breaker = CircuitBreaker(config, clock)

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
    fun staysOpenUntilRecoveryTimeoutHasPassed() {
        breaker.recordFailure()
        breaker.recordFailure()

        clock.advanceBy(config.recoveryTimeoutMs.milliseconds)
        assertTrue(breaker.isOpen())
        assertEquals(CircuitBreakerState.OPEN, breaker.getState())

        clock.advanceBy(1.milliseconds)
        assertFalse(breaker.isOpen())
        assertEquals(CircuitBreakerState.HALF_OPEN, breaker.getState())
    }

    @Test
    fun transitionsToHalfOpenAfterTimeoutAndClosesOnSuccess() {
        breaker.recordFailure()
        breaker.recordFailure()
        assertTrue(breaker.isOpen())

        clock.advanceBy((config.recoveryTimeoutMs + 1).milliseconds)
        assertFalse(breaker.isOpen())
        assertEquals(CircuitBreakerState.HALF_OPEN, breaker.getState())

        breaker.recordSuccess()
        assertEquals(CircuitBreakerState.HALF_OPEN, breaker.getState())

        breaker.recordSuccess()
        assertEquals(CircuitBreakerState.CLOSED, breaker.getState())
        assertFalse(breaker.isOpen())
    }

    @Test
    fun failureDuringHalfOpenReopensCircuit() {
        breaker.recordFailure()
        breaker.recordFailure()
        clock.advanceBy((config.recoveryTimeoutMs + 1).milliseconds)
        assertFalse(breaker.isOpen()) // transitions to half-open

        breaker.recordFailure()
        assertTrue(breaker.isOpen())
        assertEquals(CircuitBreakerState.OPEN, breaker.getState())
    }
}
