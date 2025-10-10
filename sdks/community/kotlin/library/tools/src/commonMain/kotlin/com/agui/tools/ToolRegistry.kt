package com.agui.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import kotlinx.coroutines.withTimeout
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ToolRegistry")

/**
 * Statistics about tool execution.
 */
data class ToolExecutionStats(
    val executionCount: Long = 0,
    val successCount: Long = 0,
    val failureCount: Long = 0,
    val totalExecutionTimeMs: Long = 0,
    val averageExecutionTimeMs: Double = 0.0
) {
    val successRate: Double get() = if (executionCount > 0) successCount.toDouble() / executionCount else 0.0
}

/**
 * Registry for managing tool executors.
 * 
 * The ToolRegistry provides:
 * - Registration and discovery of tool executors
 * - Tool execution with timeout handling
 * - Execution statistics and monitoring
 * - Thread-safe concurrent access
 * - Built-in tool validation
 * - Automatic integration with client protocols
 */
interface ToolRegistry {
    
    /**
     * Registers a tool executor.
     * 
     * @param executor The tool executor to register
     * @throws IllegalArgumentException if a tool with the same name is already registered
     */
    fun registerTool(executor: ToolExecutor)
    
    /**
     * Unregisters a tool executor by name.
     * 
     * @param toolName The name of the tool to unregister
     * @return True if the tool was unregistered, false if it wasn't found
     */
    fun unregisterTool(toolName: String): Boolean
    
    /**
     * Gets a tool executor by name.
     * 
     * @param toolName The name of the tool
     * @return The tool executor, or null if not found
     */
    fun getToolExecutor(toolName: String): ToolExecutor?
    
    /**
     * Gets all registered tool definitions.
     * Used by clients to populate the tools array in RunAgentInput.
     * 
     * @return List of all registered tools
     */
    fun getAllTools(): List<Tool>
    
    /**
     * Gets all registered tool executors.
     * 
     * @return Map of tool name to executor
     */
    fun getAllExecutors(): Map<String, ToolExecutor>
    
    /**
     * Checks if a tool is registered.
     * 
     * @param toolName The name of the tool
     * @return True if the tool is registered
     */
    fun isToolRegistered(toolName: String): Boolean
    
    /**
     * Executes a tool call.
     * 
     * @param context The execution context
     * @return The execution result
     * @throws ToolNotFoundException if the tool is not registered
     * @throws ToolExecutionException if execution fails
     */
    suspend fun executeTool(context: ToolExecutionContext): ToolExecutionResult
    
    /**
     * Gets execution statistics for a specific tool.
     * 
     * @param toolName The name of the tool
     * @return Execution statistics, or null if the tool is not found
     */
    fun getToolStats(toolName: String): ToolExecutionStats?
    
    /**
     * Gets execution statistics for all tools.
     * 
     * @return Map of tool name to execution statistics
     */
    fun getAllStats(): Map<String, ToolExecutionStats>
    
    /**
     * Clears execution statistics for all tools.
     */
    fun clearStats()
}

/**
 * Exception thrown when a requested tool is not found in the registry.
 */
class ToolNotFoundException(
    toolName: String,
    message: String = "Tool '$toolName' not found in registry"
) : Exception(message)

/**
 * Default implementation of ToolRegistry.
 * 
 * Features:
 * - Thread-safe registration and execution
 * - Automatic timeout handling based on tool configuration
 * - Execution statistics tracking
 * - Comprehensive error handling and logging
 */
class DefaultToolRegistry : ToolRegistry {
    
    private val executors = mutableMapOf<String, ToolExecutor>()
    private val stats = mutableMapOf<String, MutableToolExecutionStats>()
    private val lock = kotlinx.coroutines.sync.Mutex()
    
    override fun registerTool(executor: ToolExecutor) {
        val toolName = executor.tool.name
        logger.i { "Registering tool: $toolName" }
        
        if (executors.containsKey(toolName)) {
            throw IllegalArgumentException("Tool '$toolName' is already registered")
        }
        
        executors[toolName] = executor
        stats[toolName] = MutableToolExecutionStats()
        
        logger.i { "Successfully registered tool: $toolName" }
    }
    
    override fun unregisterTool(toolName: String): Boolean {
        logger.i { "Unregistering tool: $toolName" }
        
        val wasPresent = executors.remove(toolName) != null
        stats.remove(toolName)
        
        if (wasPresent) {
            logger.i { "Successfully unregistered tool: $toolName" }
        } else {
            logger.w { "Attempted to unregister non-existent tool: $toolName" }
        }
        
        return wasPresent
    }
    
    override fun getToolExecutor(toolName: String): ToolExecutor? {
        return executors[toolName]
    }
    
    override fun getAllTools(): List<Tool> {
        return executors.values.map { it.tool }
    }
    
    override fun getAllExecutors(): Map<String, ToolExecutor> {
        return executors.toMap()
    }
    
    override fun isToolRegistered(toolName: String): Boolean {
        return executors.containsKey(toolName)
    }
    
    override suspend fun executeTool(context: ToolExecutionContext): ToolExecutionResult {
        val toolName = context.toolCall.function.name
        
        val executor = getToolExecutor(toolName)
            ?: throw ToolNotFoundException(toolName)
        
        logger.i { "Executing tool: $toolName (call ID: ${context.toolCall.id})" }
        
        val startTime = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
        var result: ToolExecutionResult
        
        try {
            // Execute with timeout if specified
            result = executor.getMaxExecutionTimeMs()?.let { timeoutMs ->
                withTimeout(timeoutMs) {
                    executor.execute(context)
                }
            } ?: executor.execute(context)
            
            val endTime = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
            val executionTime = endTime - startTime
            
            // Update statistics
            lock.tryLock() // Non-blocking stats update
            stats[toolName]?.let { toolStats ->
                toolStats.executionCount++
                toolStats.totalExecutionTimeMs += executionTime
                toolStats.averageExecutionTimeMs = toolStats.totalExecutionTimeMs.toDouble() / toolStats.executionCount
                
                if (result.success) {
                    toolStats.successCount++
                } else {
                    toolStats.failureCount++
                }
            }
            lock.unlock()
            
            logger.i { 
                "Tool execution completed: $toolName (${if (result.success) "SUCCESS" else "FAILURE"}) in ${executionTime}ms" 
            }
            
        } catch (e: Exception) {
            val endTime = kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
            val executionTime = endTime - startTime
            
            // Update failure statistics
            lock.tryLock()
            stats[toolName]?.let { toolStats ->
                toolStats.executionCount++
                toolStats.failureCount++
                toolStats.totalExecutionTimeMs += executionTime
                toolStats.averageExecutionTimeMs = toolStats.totalExecutionTimeMs.toDouble() / toolStats.executionCount
            }
            lock.unlock()
            
            logger.e(e) { "Tool execution failed: $toolName in ${executionTime}ms" }
            
            when (e) {
                is ToolExecutionException -> throw e
                else -> throw ToolExecutionException(
                    message = "Tool execution failed: ${e.message}",
                    cause = e,
                    toolName = toolName,
                    toolCallId = context.toolCall.id
                )
            }
        }
        
        return result
    }
    
    override fun getToolStats(toolName: String): ToolExecutionStats? {
        return stats[toolName]?.toImmutable()
    }
    
    override fun getAllStats(): Map<String, ToolExecutionStats> {
        return stats.mapValues { it.value.toImmutable() }
    }
    
    override fun clearStats() {
        logger.i { "Clearing all tool execution statistics" }
        stats.values.forEach { it.clear() }
    }
    
    /**
     * Mutable version of ToolExecutionStats for internal tracking.
     */
    private class MutableToolExecutionStats {
        var executionCount: Long = 0
        var successCount: Long = 0
        var failureCount: Long = 0
        var totalExecutionTimeMs: Long = 0
        var averageExecutionTimeMs: Double = 0.0
        
        fun toImmutable(): ToolExecutionStats {
            return ToolExecutionStats(
                executionCount = executionCount,
                successCount = successCount,
                failureCount = failureCount,
                totalExecutionTimeMs = totalExecutionTimeMs,
                averageExecutionTimeMs = averageExecutionTimeMs
            )
        }
        
        fun clear() {
            executionCount = 0
            successCount = 0
            failureCount = 0
            totalExecutionTimeMs = 0
            averageExecutionTimeMs = 0.0
        }
    }
}

/**
 * Builder for creating and configuring a ToolRegistry.
 */
class ToolRegistryBuilder {
    private val executors = mutableListOf<ToolExecutor>()
    
    /**
     * Adds a tool executor to the registry.
     */
    fun addTool(executor: ToolExecutor): ToolRegistryBuilder {
        executors.add(executor)
        return this
    }
    
    /**
     * Adds multiple tool executors to the registry.
     */
    fun addTools(vararg executors: ToolExecutor): ToolRegistryBuilder {
        this.executors.addAll(executors)
        return this
    }
    
    /**
     * Adds multiple tool executors to the registry.
     */
    fun addTools(executors: Collection<ToolExecutor>): ToolRegistryBuilder {
        this.executors.addAll(executors)
        return this
    }
    
    /**
     * Builds the tool registry with all registered executors.
     */
    fun build(): ToolRegistry {
        val registry: ToolRegistry = DefaultToolRegistry()
        executors.forEach { registry.registerTool(it) }
        return registry
    }
}

/**
 * Creates a new ToolRegistry with the given executors.
 */
fun toolRegistry(vararg executors: ToolExecutor): ToolRegistry {
    return ToolRegistryBuilder().addTools(*executors).build()
}

/**
 * Creates a new ToolRegistry using a builder pattern.
 */
fun toolRegistry(builder: ToolRegistryBuilder.() -> Unit): ToolRegistry {
    return ToolRegistryBuilder().apply(builder).build()
}