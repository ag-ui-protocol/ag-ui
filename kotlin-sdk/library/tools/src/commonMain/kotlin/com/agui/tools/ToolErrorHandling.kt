package com.agui.tools

import com.agui.core.types.ToolCall
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ToolErrorHandling")

/**
 * Comprehensive error handling and recovery system for tool execution.
 * 
 * This class provides sophisticated error handling capabilities for tool execution,
 * including retry strategies, circuit breaker patterns, error categorization,
 * and execution tracking. It's designed to improve system reliability and
 * provide meaningful feedback when tools fail.
 * 
 * Key Features:
 * - Multiple retry strategies (fixed, linear, exponential, exponential with jitter)
 * - Circuit breaker pattern to prevent cascading failures
 * - Error categorization for appropriate handling
 * - Execution history tracking for debugging and monitoring
 * - User-friendly error message generation
 * - Configurable timeout and resource error handling
 * 
 * The error handler works by:
 * 1. Recording execution attempts and their outcomes
 * 2. Categorizing errors to determine retry eligibility
 * 3. Applying retry strategies with configurable delays
 * 4. Managing circuit breakers to fail fast when tools are consistently failing
 * 5. Providing detailed statistics and error reporting
 * 
 * Thread Safety:
 * This class is thread-safe and can handle concurrent tool executions.
 * 
 * @param config Configuration for error handling behavior
 * 
 * @see ToolErrorConfig
 * @see CircuitBreaker
 * @see ToolErrorDecision
 */
class ToolErrorHandler(
    private val config: ToolErrorConfig = ToolErrorConfig()
) {
    
    private val executionHistory = mutableMapOf<String, MutableList<ToolExecutionAttempt>>()
    private val circuitBreakers = mutableMapOf<String, CircuitBreaker>()
    
    /**
     * Handles a tool execution error and determines the appropriate response.
     * 
     * @param error The error that occurred
     * @param context The execution context
     * @param attempt The current attempt number
     * @return Error handling decision
     */
    suspend fun handleError(
        error: Throwable,
        context: ToolExecutionContext,
        attempt: Int
    ): ToolErrorDecision {
        val toolName = context.toolCall.function.name
        val now = Clock.System.now()
        
        // Record the execution attempt
        recordExecutionAttempt(context, error, attempt, now)
        
        // Check circuit breaker
        val circuitBreaker = getOrCreateCircuitBreaker(toolName)
        if (circuitBreaker.isOpen()) {
            logger.w { "Circuit breaker is open for tool: $toolName" }
            return ToolErrorDecision.Fail(
                message = "Tool '$toolName' is temporarily unavailable due to repeated failures",
                shouldReport = false
            )
        }
        
        // Determine if we should retry
        val shouldRetry = shouldRetryError(error, context, attempt)
        
        if (shouldRetry) {
            val retryDelay = calculateRetryDelay(attempt)
            logger.i { "Retrying tool execution: $toolName (attempt $attempt) after ${retryDelay}ms" }
            
            return ToolErrorDecision.Retry(
                delayMs = retryDelay,
                maxAttempts = config.maxRetryAttempts
            )
        } else {
            // Record failure in circuit breaker
            circuitBreaker.recordFailure()
            
            val errorCategory = categorizeError(error)
            val userMessage = generateUserFriendlyMessage(error, errorCategory, toolName)
            
            logger.e(error) { "Tool execution failed permanently: $toolName after $attempt attempts" }
            
            return ToolErrorDecision.Fail(
                message = userMessage,
                shouldReport = errorCategory.shouldReport
            )
        }
    }
    
    /**
     * Records a successful tool execution to reset circuit breakers and clear history.
     * 
     * This method should be called after every successful tool execution to:
     * - Reset circuit breaker failure counts
     * - Clear error history for the tool
     * - Update success statistics
     * 
     * @param toolName The name of the tool that executed successfully
     */
    fun recordSuccess(toolName: String) {
        circuitBreakers[toolName]?.recordSuccess()
        executionHistory[toolName]?.clear()
    }
    
    /**
     * Gets comprehensive error statistics for a specific tool.
     * 
     * The statistics include execution counts, failure rates, circuit breaker state,
     * and timing information. Recent failures are counted within the last hour.
     * 
     * @param toolName The name of the tool to get statistics for
     * @return Error statistics for the tool, or default values if tool not found
     * 
     * @see ToolErrorStats
     */
    fun getErrorStats(toolName: String): ToolErrorStats {
        val attempts = executionHistory[toolName] ?: emptyList()
        val circuitBreaker = circuitBreakers[toolName]
        val oneHourAgoMs = Clock.System.now().toEpochMilliseconds() - (60 * 60 * 1000) // 1 hour in ms
        val oneHourAgo = kotlinx.datetime.Instant.fromEpochMilliseconds(oneHourAgoMs)
        
        return ToolErrorStats(
            toolName = toolName,
            totalAttempts = attempts.size,
            recentFailures = attempts.count { it.timestamp > oneHourAgo },
            circuitBreakerState = circuitBreaker?.getState() ?: CircuitBreakerState.CLOSED,
            lastErrorTime = attempts.maxByOrNull { it.timestamp }?.timestamp
        )
    }
    
    /**
     * Resets all error state for a tool (useful for manual recovery).
     * 
     * This method clears:
     * - All execution history for the tool
     * - Circuit breaker state (returns to CLOSED)
     * - Failure and success counters
     * 
     * Use this method when you want to give a tool a fresh start,
     * for example after fixing underlying issues or for manual recovery.
     * 
     * @param toolName The name of the tool to reset
     */
    fun resetErrorState(toolName: String) {
        executionHistory[toolName]?.clear()
        circuitBreakers[toolName]?.reset()
        logger.i { "Reset error state for tool: $toolName" }
    }
    
    private fun shouldRetryError(error: Throwable, context: ToolExecutionContext, attempt: Int): Boolean {
        // Don't retry if we've exceeded max attempts
        if (attempt >= config.maxRetryAttempts) {
            return false
        }
        
        // Check error type for retry eligibility
        return when (error) {
            is ToolNotFoundException -> false // Tool doesn't exist, no point in retrying
            is ToolValidationException -> false // Validation errors are permanent
            is IllegalStateException -> false // Security violations are permanent
            is ToolTimeoutException -> true // Timeouts can be transient
            is ToolNetworkException -> true // Network issues can be transient
            is ToolResourceException -> config.retryOnResourceErrors // Configurable
            else -> config.retryOnUnknownErrors // Configurable
        }
    }
    
    private fun calculateRetryDelay(attempt: Int): Long {
        return when (config.retryStrategy) {
            RetryStrategy.FIXED -> config.baseRetryDelayMs
            RetryStrategy.LINEAR -> config.baseRetryDelayMs * attempt
            RetryStrategy.EXPONENTIAL -> {
                val delay = config.baseRetryDelayMs * (1 shl (attempt - 1))
                minOf(delay, config.maxRetryDelayMs)
            }
            RetryStrategy.EXPONENTIAL_JITTER -> {
                val delay = config.baseRetryDelayMs * (1 shl (attempt - 1))
                val jitter = (delay * 0.1 * kotlin.random.Random.nextDouble()).toLong()
                minOf(delay + jitter, config.maxRetryDelayMs)
            }
        }
    }
    
    private fun categorizeError(error: Throwable): ErrorCategory {
        return when (error) {
            is ToolNotFoundException -> ErrorCategory.CONFIGURATION_ERROR
            is ToolValidationException -> ErrorCategory.USER_ERROR
            is IllegalStateException -> ErrorCategory.SECURITY_ERROR
            is ToolTimeoutException -> ErrorCategory.TRANSIENT_ERROR
            is ToolNetworkException -> ErrorCategory.TRANSIENT_ERROR
            is ToolResourceException -> ErrorCategory.RESOURCE_ERROR
            else -> ErrorCategory.UNKNOWN_ERROR
        }
    }
    
    private fun generateUserFriendlyMessage(error: Throwable, category: ErrorCategory, toolName: String): String {
        return when (category) {
            ErrorCategory.CONFIGURATION_ERROR -> 
                "The tool '$toolName' is not properly configured or is unavailable."
            ErrorCategory.USER_ERROR -> 
                "Invalid parameters provided to tool '$toolName': ${error.message}"
            ErrorCategory.SECURITY_ERROR -> 
                "Access denied for tool '$toolName'. Please check permissions."
            ErrorCategory.TRANSIENT_ERROR -> 
                "Tool '$toolName' is temporarily unavailable. Please try again later."
            ErrorCategory.RESOURCE_ERROR -> 
                "Tool '$toolName' failed due to resource constraints. Please try again later."
            ErrorCategory.UNKNOWN_ERROR -> 
                "Tool '$toolName' encountered an unexpected error: ${error.message}"
        }
    }
    
    private fun recordExecutionAttempt(
        context: ToolExecutionContext,
        error: Throwable,
        attempt: Int,
        timestamp: Instant
    ) {
        val toolName = context.toolCall.function.name
        val attempts = executionHistory.getOrPut(toolName) { mutableListOf() }
        
        attempts.add(ToolExecutionAttempt(
            toolCall = context.toolCall,
            error = error,
            attempt = attempt,
            timestamp = timestamp
        ))
        
        // Limit history size
        if (attempts.size > config.maxHistorySize) {
            attempts.removeAt(0)
        }
    }
    
    private fun getOrCreateCircuitBreaker(toolName: String): CircuitBreaker {
        return circuitBreakers.getOrPut(toolName) {
            CircuitBreaker(config.circuitBreakerConfig)
        }
    }
}

/**
 * Configuration for tool error handling behavior.
 * 
 * This class defines how the error handler should behave when tools fail,
 * including retry strategies, timeout settings, and circuit breaker configuration.
 * 
 * @param maxRetryAttempts Maximum number of retry attempts before giving up (default: 3)
 * @param baseRetryDelayMs Base delay in milliseconds between retries (default: 1000ms)
 * @param maxRetryDelayMs Maximum delay in milliseconds for exponential backoff (default: 30000ms)
 * @param retryStrategy Strategy to use for calculating retry delays (default: EXPONENTIAL_JITTER)
 * @param retryOnResourceErrors Whether to retry when resource errors occur (default: true)
 * @param retryOnUnknownErrors Whether to retry when unknown errors occur (default: false)
 * @param maxHistorySize Maximum number of execution attempts to keep in history (default: 100)
 * @param circuitBreakerConfig Configuration for the circuit breaker pattern
 * 
 * @see RetryStrategy
 * @see CircuitBreakerConfig
 */
data class ToolErrorConfig(
    val maxRetryAttempts: Int = 3,
    val baseRetryDelayMs: Long = 1000L,
    val maxRetryDelayMs: Long = 30000L,
    val retryStrategy: RetryStrategy = RetryStrategy.EXPONENTIAL_JITTER,
    val retryOnResourceErrors: Boolean = true,
    val retryOnUnknownErrors: Boolean = false,
    val maxHistorySize: Int = 100,
    val circuitBreakerConfig: CircuitBreakerConfig = CircuitBreakerConfig()
)

/**
 * Configuration for circuit breaker behavior.
 * 
 * Circuit breakers help prevent cascading failures by temporarily stopping
 * execution of tools that are consistently failing. This reduces load on
 * failing systems and provides faster failure responses.
 * 
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Fast-failing, requests are rejected immediately
 * - HALF_OPEN: Testing recovery, limited requests pass through
 * 
 * @param failureThreshold Number of failures before opening the circuit (default: 5)
 * @param recoveryTimeoutMs Time in milliseconds before testing recovery (default: 60000ms)
 * @param successThreshold Number of successes needed to close the circuit (default: 2)
 * 
 * @see CircuitBreakerState
 * @see CircuitBreaker
 */
data class CircuitBreakerConfig(
    val failureThreshold: Int = 5,
    val recoveryTimeoutMs: Long = 60000L, // 1 minute
    val successThreshold: Int = 2
)

/**
 * Available retry strategies for failed tool executions.
 * 
 * Different strategies provide different patterns for spacing retry attempts:
 * - FIXED: Same delay between all retries
 * - LINEAR: Delay increases linearly with attempt number
 * - EXPONENTIAL: Delay doubles with each attempt (exponential backoff)
 * - EXPONENTIAL_JITTER: Exponential backoff with random jitter to avoid thundering herd
 * 
 * @see ToolErrorConfig.retryStrategy
 */
enum class RetryStrategy {
    FIXED,
    LINEAR,
    EXPONENTIAL,
    EXPONENTIAL_JITTER
}

/**
 * Categories for classifying different types of tool execution errors.
 * 
 * Error categorization helps determine the appropriate response and
 * whether errors should be reported to monitoring systems.
 * 
 * @param shouldReport Whether errors of this category should be reported to monitoring/logging systems
 * 
 * Categories:
 * - CONFIGURATION_ERROR: Tool setup or configuration issues (reportable)
 * - USER_ERROR: Invalid user input or parameters (not reportable)
 * - SECURITY_ERROR: Permission or security violations (reportable)
 * - TRANSIENT_ERROR: Temporary failures that may resolve (not reportable)
 * - RESOURCE_ERROR: Resource exhaustion or constraints (reportable)
 * - UNKNOWN_ERROR: Unclassified errors (reportable)
 */
enum class ErrorCategory(val shouldReport: Boolean) {
    CONFIGURATION_ERROR(true),
    USER_ERROR(false),
    SECURITY_ERROR(true),
    TRANSIENT_ERROR(false),
    RESOURCE_ERROR(true),
    UNKNOWN_ERROR(true)
}

/**
 * Represents a decision on how to handle a tool execution error.
 * 
 * The error handler analyzes failures and returns one of these decisions:
 * - Retry: Attempt the tool execution again with specified parameters
 * - Fail: Give up on the tool execution and return an error
 * 
 * @see ToolErrorHandler.handleError
 */
sealed class ToolErrorDecision {
    data class Retry(
        val delayMs: Long,
        val maxAttempts: Int
    ) : ToolErrorDecision()
    
    data class Fail(
        val message: String,
        val shouldReport: Boolean
    ) : ToolErrorDecision()
}

/**
 * Comprehensive statistics about tool execution errors and performance.
 * 
 * This class provides detailed metrics about a tool's execution history,
 * including success rates, failure patterns, and current circuit breaker state.
 * 
 * @param toolName The name of the tool these statistics apply to
 * @param totalAttempts Total number of execution attempts recorded
 * @param recentFailures Number of failures in the last hour
 * @param circuitBreakerState Current state of the tool's circuit breaker
 * @param lastErrorTime Timestamp of the most recent error, if any
 * 
 * @see CircuitBreakerState
 */
data class ToolErrorStats(
    val toolName: String,
    val totalAttempts: Int,
    val recentFailures: Int,
    val circuitBreakerState: CircuitBreakerState,
    val lastErrorTime: Instant?
)

/**
 * Record of a single tool execution attempt.
 * 
 * This class captures the details of an individual tool execution attempt,
 * including the tool call details, any error that occurred, and timing information.
 * These records are used for debugging, statistics, and retry decision-making.
 * 
 * @param toolCall The tool call that was attempted
 * @param error The error that occurred during execution
 * @param attempt The attempt number (1 for first attempt, 2 for first retry, etc.)
 * @param timestamp When this attempt was made
 * 
 * @see ToolCall
 */
data class ToolExecutionAttempt(
    val toolCall: ToolCall,
    val error: Throwable,
    val attempt: Int,
    val timestamp: Instant
)

/**
 * Possible states for a circuit breaker.
 * 
 * Circuit breakers transition between these states based on success/failure patterns:
 * - CLOSED: Normal operation, all requests pass through
 * - OPEN: Failing fast, all requests are rejected immediately
 * - HALF_OPEN: Testing recovery, limited requests pass through to test if the service has recovered
 * 
 * State Transitions:
 * - CLOSED → OPEN: When failure threshold is exceeded
 * - OPEN → HALF_OPEN: After recovery timeout expires
 * - HALF_OPEN → CLOSED: When success threshold is met
 * - HALF_OPEN → OPEN: When any failure occurs during recovery testing
 * 
 * @see CircuitBreaker
 * @see CircuitBreakerConfig
 */
enum class CircuitBreakerState {
    CLOSED,    // Normal operation
    OPEN,      // Failing fast
    HALF_OPEN  // Testing recovery
}

/**
 * Circuit breaker implementation for tool execution reliability.
 * 
 * This class implements the circuit breaker pattern to prevent cascading failures
 * and provide fast failure responses when tools are consistently failing.
 * 
 * The circuit breaker maintains internal state and counters to track:
 * - Number of consecutive failures
 * - Number of consecutive successes (during recovery)
 * - Timestamp of last failure (for recovery timeout)
 * - Current circuit state
 * 
 * Behavior:
 * - In CLOSED state: All calls pass through, failures are counted
 * - In OPEN state: All calls fail fast, recovery timeout is monitored
 * - In HALF_OPEN state: Limited calls pass through to test recovery
 * 
 * Thread Safety:
 * This class is thread-safe for concurrent access.
 * 
 * @param config Configuration for circuit breaker behavior
 * 
 * @see CircuitBreakerConfig
 * @see CircuitBreakerState
 */
class CircuitBreaker(private val config: CircuitBreakerConfig) {
    
    private var _state = CircuitBreakerState.CLOSED
    private var failures = 0
    private var successes = 0
    private var lastFailureTime: Instant? = null
    
    /**
     * Gets the current state of the circuit breaker.
     * 
     * @return The current circuit breaker state
     * @see CircuitBreakerState
     */
    fun getState(): CircuitBreakerState = _state
    
    /**
     * Checks if the circuit breaker is currently open (failing fast).
     * 
     * For OPEN state, this method also checks if the recovery timeout has expired
     * and automatically transitions to HALF_OPEN if it has.
     * 
     * @return True if the circuit is open and calls should fail fast
     */
    fun isOpen(): Boolean {
        return when (_state) {
            CircuitBreakerState.OPEN -> {
                val lastFailure = lastFailureTime
                if (lastFailure != null && 
                    Clock.System.now().toEpochMilliseconds() - lastFailure.toEpochMilliseconds() > config.recoveryTimeoutMs) {
                    // Transition to half-open for testing
                    _state = CircuitBreakerState.HALF_OPEN
                    false
                } else {
                    true
                }
            }
            CircuitBreakerState.HALF_OPEN -> false
            CircuitBreakerState.CLOSED -> false
        }
    }
    
    /**
     * Records a failure and updates circuit breaker state accordingly.
     * 
     * This method should be called after every failed tool execution.
     * It increments failure counters and may transition the circuit to OPEN
     * if the failure threshold is exceeded.
     * 
     * State Transitions:
     * - CLOSED → OPEN: If failure threshold is reached
     * - HALF_OPEN → OPEN: Any failure during recovery testing
     */
    fun recordFailure() {
        failures++
        lastFailureTime = Clock.System.now()
        
        when (_state) {
            CircuitBreakerState.CLOSED -> {
                if (failures >= config.failureThreshold) {
                    _state = CircuitBreakerState.OPEN
                    logger.w { "Circuit breaker opened after $failures failures" }
                }
            }
            CircuitBreakerState.HALF_OPEN -> {
                _state = CircuitBreakerState.OPEN
                logger.w { "Circuit breaker reopened after failure during recovery" }
            }
            CircuitBreakerState.OPEN -> {
                // Already open, just update counters
            }
        }
    }
    
    /**
     * Records a successful execution and updates circuit breaker state accordingly.
     * 
     * This method should be called after every successful tool execution.
     * It resets failure counters and may transition the circuit to CLOSED
     * if enough successes are recorded during recovery.
     * 
     * State Transitions:
     * - HALF_OPEN → CLOSED: If success threshold is reached during recovery
     * - CLOSED: Resets failure counter to maintain healthy state
     */
    fun recordSuccess() {
        when (_state) {
            CircuitBreakerState.CLOSED -> {
                // Reset failure count on success
                failures = 0
            }
            CircuitBreakerState.HALF_OPEN -> {
                successes++
                if (successes >= config.successThreshold) {
                    _state = CircuitBreakerState.CLOSED
                    failures = 0
                    successes = 0
                    logger.i { "Circuit breaker closed after recovery" }
                }
            }
            CircuitBreakerState.OPEN -> {
                // Should not happen, but reset state
                _state = CircuitBreakerState.CLOSED
                failures = 0
                successes = 0
            }
        }
    }
    
    /**
     * Manually resets the circuit breaker to CLOSED state.
     * 
     * This method clears all counters and state, effectively giving
     * the circuit breaker a fresh start. Use this for manual recovery
     * or when you know the underlying issues have been resolved.
     */
    fun reset() {
        _state = CircuitBreakerState.CLOSED
        failures = 0
        successes = 0
        lastFailureTime = null
    }
}

// Specific tool exception types for better error handling

/**
 * Exception thrown when tool call validation fails.
 * 
 * This exception indicates that the tool call arguments are invalid,
 * missing required parameters, or fail schema validation. These errors
 * are typically not retryable as they indicate user or client errors.
 * 
 * @param message Description of the validation failure
 * @param cause Optional underlying cause of the validation failure
 */
open class ToolValidationException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Exception thrown when tool execution times out.
 * 
 * This exception indicates that a tool took longer than the configured
 * timeout period to complete. Timeout errors are often transient and
 * may be worth retrying, especially if the timeout was due to temporary
 * network or system load issues.
 * 
 * @param message Description of the timeout
 * @param cause Optional underlying cause of the timeout
 */
open class ToolTimeoutException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Exception thrown when tool execution fails due to network issues.
 * 
 * This exception indicates network-related failures such as connection
 * timeouts, DNS resolution failures, or service unavailability. These
 * errors are typically transient and may be worth retrying after a delay.
 * 
 * @param message Description of the network failure
 * @param cause Optional underlying cause of the network failure
 */
open class ToolNetworkException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Exception thrown when tool execution fails due to resource constraints.
 * 
 * This exception indicates failures related to resource exhaustion such as
 * out of memory, disk space, rate limiting, or quota exceeded. Whether these
 * errors are retryable depends on the specific resource constraint and
 * system configuration.
 * 
 * @param message Description of the resource constraint
 * @param cause Optional underlying cause of the resource failure
 */
open class ToolResourceException(message: String, cause: Throwable? = null) : Exception(message, cause)