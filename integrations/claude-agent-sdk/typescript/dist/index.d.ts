import { Observable } from 'rxjs';
import { AgentConfig, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, ToolCallStartEvent, ToolCallArgsEvent, ToolCallEndEvent, ToolCallResultEvent, RunStartedEvent, RunFinishedEvent, RunErrorEvent, StepStartedEvent, StepFinishedEvent, Message, AbstractAgent, RunAgentInput, Tool } from '@ag-ui/client';

/**
 * Type definitions for Claude Agent SDK integration with AG-UI Protocol
 */

interface ClaudeSDKClient {
    query(prompt: string): Promise<void>;
    receiveResponse(): AsyncIterableIterator<SDKMessage>;
    close(): Promise<void>;
}
interface Options {
    apiKey?: string;
    baseUrl?: string;
    mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
    allowedTools?: string[];
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'ask' | 'auto' | 'none';
    stderr?: (data: string) => void;
    verbose?: boolean;
    [key: string]: any;
}
interface Query {
    next(): Promise<IteratorResult<SDKMessage, void>>;
    [Symbol.asyncIterator](): AsyncIterableIterator<SDKMessage>;
}
type SDKMessage = SDKAssistantMessage | SDKUserMessage | SDKSystemMessage | SDKResultMessage | SDKPartialAssistantMessage | SDKCompactBoundaryMessage | SDKPermissionDenial;
interface SDKAssistantMessage {
    type: 'assistant';
    message: {
        id?: string;
        content: ContentBlock[];
        [key: string]: any;
    };
    parent_tool_use_id?: string | null;
    uuid?: string;
    session_id?: string;
}
interface SDKUserMessage {
    type: 'user';
    content: string;
    id?: string;
}
interface SDKSystemMessage {
    type: 'system';
    content: string;
}
interface SDKResultMessage {
    type: 'result';
    subtype: 'success' | 'error';
    error?: {
        type: string;
        message: string;
    };
}
interface SDKPartialAssistantMessage {
    type: 'partial_assistant';
    content: ContentBlock[];
}
interface SDKCompactBoundaryMessage {
    type: 'compact_boundary';
}
interface SDKPermissionDenial {
    type: 'permission_denial';
    tool: string;
    reason: string;
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock;
interface TextBlock {
    type: 'text';
    text: string;
}
interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: Record<string, any>;
}
interface ToolResultBlock {
    type: 'tool_result';
    tool_use_id: string;
    content: string | Array<{
        type: string;
        [key: string]: any;
    }>;
    is_error?: boolean;
}
interface ThinkingBlock {
    type: 'thinking';
    thinking: string;
}
interface SdkMcpToolDefinition<Schema = any> {
    name: string;
    description: string;
    inputSchema: Schema;
    handler: (args: any, extra?: any) => Promise<CallToolResult>;
}
interface CallToolResult {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: string;
        mimeType?: string;
        [key: string]: any;
    }>;
    isError?: boolean;
}
interface McpSdkServerConfigWithInstance {
    name: string;
    version?: string;
    tools?: Array<SdkMcpToolDefinition<any>>;
}
type ProcessedEvents = TextMessageStartEvent | TextMessageContentEvent | TextMessageEndEvent | ToolCallStartEvent | ToolCallArgsEvent | ToolCallEndEvent | ToolCallResultEvent | RunStartedEvent | RunFinishedEvent | RunErrorEvent | StepStartedEvent | StepFinishedEvent;
interface Session {
    id: string;
    userId?: string;
    client?: ClaudeSDKClient;
    processedMessageIds: Set<string>;
    state: Record<string, any>;
    createdAt: number;
    lastAccessedAt: number;
}
interface ClaudeAgentConfig extends AgentConfig {
    apiKey?: string;
    baseUrl?: string;
    sessionTimeout?: number;
    enablePersistentSessions?: boolean;
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'ask' | 'auto' | 'none';
    mcpServers?: Record<string, McpSdkServerConfigWithInstance>;
    stderr?: (data: string) => void;
    verbose?: boolean;
}
interface ExecutionState$1 {
    id: string;
    sessionId: string;
    isRunning: boolean;
    startTime: number;
    events: ProcessedEvents[];
    error?: Error;
}
declare function isAssistantMessage(message: SDKMessage): message is SDKAssistantMessage;
declare function isResultMessage(message: SDKMessage): message is SDKResultMessage;
declare function isTextBlock(block: ContentBlock): block is TextBlock;
declare function isToolUseBlock(block: ContentBlock): block is ToolUseBlock;
declare function isToolResultBlock(block: ContentBlock): block is ToolResultBlock;
declare function isThinkingBlock(block: ContentBlock): block is ThinkingBlock;
declare function hasContentProperty(message: SDKMessage): message is SDKAssistantMessage | SDKPartialAssistantMessage;
interface ToolExecutionContext {
    toolName: string;
    toolCallId: string;
    isClientTool: boolean;
    isLongRunning: boolean;
}
interface ConvertedMessage {
    role: 'user' | 'assistant' | 'system';
    content: string | Array<{
        type: string;
        [key: string]: any;
    }>;
}

/**
 * Session manager: Manages agent sessions and state
 */

/**
 * SessionManager handles session lifecycle, message tracking, and state management
 * Implements singleton pattern for centralized session control
 */
declare class SessionManager {
    private static instance;
    private sessions;
    private cleanupInterval;
    private sessionTimeout;
    private constructor();
    /**
     * Get the singleton instance
     */
    static getInstance(sessionTimeout?: number): SessionManager;
    /**
     * Reset the singleton instance (useful for testing)
     */
    static resetInstance(): void;
    /**
     * Get or create a session
     */
    getSession(sessionId: string, userId?: string): Session;
    /**
     * Check if a session exists
     */
    hasSession(sessionId: string): boolean;
    /**
     * Delete a session
     */
    deleteSession(sessionId: string): boolean;
    /**
     * Track a processed message
     */
    trackMessage(sessionId: string, messageId: string): void;
    /**
     * Check if a message has been processed
     */
    isMessageProcessed(sessionId: string, messageId: string): boolean;
    /**
     * Get unseen messages (messages not yet processed)
     */
    getUnseenMessages(sessionId: string, messages: Message[]): Message[];
    /**
     * Mark messages as processed
     */
    markMessagesAsProcessed(sessionId: string, messages: Message[]): void;
    /**
     * Get state value from session
     */
    getStateValue(sessionId: string, key: string): any;
    /**
     * Set state value in session
     */
    setStateValue(sessionId: string, key: string, value: any): void;
    /**
     * Remove state keys from session
     */
    removeStateKeys(sessionId: string, keys: string[]): void;
    /**
     * Clear all state for a session
     */
    clearSessionState(sessionId: string): void;
    /**
     * Set Claude SDK client for a session
     */
    setClient(sessionId: string, client: ClaudeSDKClient): void;
    /**
     * Get Claude SDK client for a session
     */
    getClient(sessionId: string): ClaudeSDKClient | undefined;
    /**
     * Get total number of sessions
     */
    getSessionCount(): number;
    /**
     * Get number of sessions for a specific user
     */
    getUserSessionCount(userId: string): number;
    /**
     * Get all session IDs
     */
    getAllSessionIds(): string[];
    /**
     * Get all sessions for a specific user
     */
    getUserSessions(userId: string): Session[];
    /**
     * Clean up stale sessions
     */
    private cleanupStaleSessions;
    /**
     * Start the cleanup interval
     */
    private startCleanupInterval;
    /**
     * Stop the cleanup interval
     */
    private stopCleanupInterval;
    /**
     * Clear all sessions (useful for testing)
     */
    clearAllSessions(): void;
}

/**
 * Execution state: Tracks background Claude executions
 */

/**
 * ExecutionState manages the state of a Claude SDK execution
 */
declare class ExecutionState {
    readonly id: string;
    readonly sessionId: string;
    private _isRunning;
    private _startTime;
    private _endTime?;
    private _events;
    private _error?;
    private _abortController;
    constructor(id: string, sessionId: string);
    /**
     * Check if execution is running
     */
    get isRunning(): boolean;
    /**
     * Get start time
     */
    get startTime(): number;
    /**
     * Get end time
     */
    get endTime(): number | undefined;
    /**
     * Get duration in milliseconds
     */
    get duration(): number;
    /**
     * Get all collected events
     */
    get events(): ProcessedEvents[];
    /**
     * Get error if any
     */
    get error(): Error | undefined;
    /**
     * Get abort signal
     */
    get signal(): AbortSignal;
    /**
     * Add an event to the execution state
     */
    addEvent(event: ProcessedEvents): void;
    /**
     * Add multiple events
     */
    addEvents(events: ProcessedEvents[]): void;
    /**
     * Mark execution as completed
     */
    complete(): void;
    /**
     * Mark execution as failed
     */
    fail(error: Error): void;
    /**
     * Abort the execution
     */
    abort(): void;
    /**
     * Get execution statistics
     */
    getStats(): {
        duration: number;
        eventCount: number;
        isRunning: boolean;
        hasError: boolean;
    };
    /**
     * Clear events (useful for memory management)
     */
    clearEvents(): void;
    /**
     * Get the last N events
     */
    getLastEvents(count: number): ProcessedEvents[];
    /**
     * Check if execution has been aborted
     */
    isAborted(): boolean;
}
/**
 * ExecutionStateManager manages multiple execution states
 */
declare class ExecutionStateManager {
    private executions;
    private readonly maxExecutions;
    constructor(maxExecutions?: number);
    /**
     * Create a new execution state
     */
    createExecution(id: string, sessionId: string): ExecutionState;
    /**
     * Get an execution state by ID
     */
    getExecution(id: string): ExecutionState | undefined;
    /**
     * Check if an execution exists
     */
    hasExecution(id: string): boolean;
    /**
     * Delete an execution state
     */
    deleteExecution(id: string): boolean;
    /**
     * Get all executions for a session
     */
    getSessionExecutions(sessionId: string): ExecutionState[];
    /**
     * Get running executions
     */
    getRunningExecutions(): ExecutionState[];
    /**
     * Get completed executions
     */
    getCompletedExecutions(): ExecutionState[];
    /**
     * Abort all running executions for a session
     */
    abortSessionExecutions(sessionId: string): void;
    /**
     * Clean up old completed executions
     */
    private cleanupOldExecutions;
    /**
     * Clear all executions
     */
    clearAll(): void;
    /**
     * Get total execution count
     */
    getExecutionCount(): number;
    /**
     * Get execution statistics
     */
    getStats(): {
        total: number;
        running: number;
        completed: number;
        failed: number;
    };
}

/**
 * Claude Agent: Main agent class that integrates Claude SDK with AG-UI Protocol
 */

/**
 * ClaudeAgent integrates Claude Agent SDK with AG-UI Protocol
 */
declare class ClaudeAgent extends AbstractAgent {
    private sessionManager;
    private executionStateManager;
    private apiKey?;
    private baseUrl?;
    private sessionTimeout;
    private enablePersistentSessions;
    private permissionMode;
    private stderr?;
    private verbose?;
    constructor(config: ClaudeAgentConfig);
    /**
     * Map legacy permission modes to new SDK values for backward compatibility
     */
    private mapPermissionMode;
    /**
     * Run the agent with the given input
     */
    run(input: RunAgentInput): Observable<ProcessedEvents>;
    /**
     * Execute the agent asynchronously
     */
    private executeAgent;
    /**
     * Prepare Claude SDK options
     * SDK automatically reads ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
     * But baseUrl needs to be explicitly passed for third-party APIs
     */
    private prepareClaudeOptions;
    /**
     * Call Claude SDK
     * Note: Currently only stateless mode is supported via query() function
     */
    private callClaudeSDK;
    /**
     * Call Claude SDK in persistent session mode
     * Note: The current SDK only supports stateless mode via query() function
     * This method falls back to stateless mode
     */
    private callClaudeSDKPersistent;
    /**
     * Call Claude SDK in stateless mode
     */
    private callClaudeSDKStateless;
    /**
     * Dynamically import Claude SDK
     */
    private importClaudeSDK;
    /**
     * Abort a running execution
     */
    abortExecution(runId: string): void;
    /**
     * Get execution state
     */
    getExecutionState(runId: string): ExecutionState | undefined;
    /**
     * Get session manager (for testing)
     */
    getSessionManager(): SessionManager;
    /**
     * Get execution state manager (for testing)
     */
    getExecutionStateManager(): ExecutionStateManager;
    /**
     * Cleanup resources
     */
    cleanup(): Promise<void>;
}

/**
 * Event translator: Converts Claude SDK messages to AG-UI events
 */

/**
 * EventTranslator converts Claude SDK messages to AG-UI protocol events
 *
 * NOTE: This translator only handles SDK message translation.
 * Run lifecycle events (RUN_STARTED, RUN_FINISHED, etc.) and step events
 * are handled by ClaudeAgent.
 */
declare class EventTranslator {
    private messageIdCounter;
    private currentMessageId;
    private runId;
    private threadId;
    constructor(runId: string, threadId: string);
    /**
     * Translate a Claude SDK message to AG-UI events
     * NOTE: Does not emit RUN_STARTED, RUN_FINISHED, or STEP events - those are handled by ClaudeAgent
     */
    translateMessage(message: SDKMessage): ProcessedEvents[];
    /**
     * Translate an AssistantMessage with content blocks
     */
    private translateAssistantMessage;
    /**
     * Translate a TextBlock to text message events
     * NOTE: Step events are handled by ClaudeAgent, not here
     */
    private translateTextBlock;
    /**
     * Translate a ToolUseBlock to tool call events
     * NOTE: Step events are handled by ClaudeAgent, not here
     */
    private translateToolUseBlock;
    /**
     * Translate a ToolResultBlock to tool call result event
     */
    private translateToolResultBlock;
    /**
     * Generate a unique message ID
     */
    private generateMessageId;
    /**
     * Reset the translator state for a new execution
     */
    reset(): void;
    /**
     * Get current message ID
     */
    getCurrentMessageId(): string | null;
    /**
     * Set current message ID
     */
    setCurrentMessageId(messageId: string | null): void;
}

/**
 * Tool adapter: Converts AG-UI tools to Claude SDK format
 */

/**
 * ToolAdapter handles conversion of AG-UI tools to Claude SDK format
 */
declare class ToolAdapter {
    /**
     * Convert AG-UI tools to Claude SDK MCP tool definitions
     */
    static convertAgUiToolsToSdk(tools: Tool[]): SdkMcpToolDefinition<any>[];
    /**
     * Convert a single AG-UI tool to Claude SDK format
     */
    private static convertSingleTool;
    /**
     * Convert JSON Schema to Zod schema
     */
    private static convertJsonSchemaToZod;
    /**
     * Convert a single JSON Schema type to Zod type
     */
    private static convertJsonSchemaTypeToZod;
    /**
     * Create an MCP server configuration for AG-UI tools
     */
    static createMcpServerForTools(tools: Tool[]): Promise<any>;
    /**
     * Extract tool calls from Claude SDK response
     */
    static extractToolCalls(message: any): Array<{
        id: string;
        name: string;
        input: Record<string, any>;
    }>;
    /**
     * Check if a tool is a long-running client tool
     */
    static isClientTool(toolName: string, tools: Tool[]): boolean;
    /**
     * Check if a tool is marked as long-running
     */
    static isLongRunningTool(toolName: string, tools: Tool[]): boolean;
    /**
     * Format tool names for Claude SDK (with MCP server prefix)
     */
    static formatToolNameForSdk(toolName: string, serverName?: string): string;
    /**
     * Parse tool name from SDK format (remove MCP server prefix)
     */
    static parseToolNameFromSdk(sdkToolName: string): string;
    /**
     * Get allowed tools list for SDK options
     */
    static getAllowedToolsList(tools: Tool[], serverName?: string): string[];
}

/**
 * Message format converters
 */

/**
 * Convert AG-UI messages to a format suitable for Claude SDK
 */
declare function convertAgUiMessagesToPrompt(messages: Message[]): string;
/**
 * Extract text content from a message
 */
declare function extractMessageContent(message: Message): string;
/**
 * Convert AG-UI message to Claude message format
 */
declare function convertAgUiMessageToClaude(message: Message): ConvertedMessage;
/**
 * Convert multiple AG-UI messages to Claude format
 */
declare function convertAgUiMessagesToClaude(messages: Message[]): ConvertedMessage[];
/**
 * Check if messages contain tool results
 */
declare function hasToolResults(messages: Message[]): boolean;
/**
 * Extract tool results from messages
 */
declare function extractToolResults(messages: Message[]): Array<{
    toolCallId: string;
    result: string;
}>;
/**
 * Generate a unique run ID
 */
declare function generateRunId(): string;
/**
 * Generate a unique message ID
 */
declare function generateMessageId(prefix?: string): string;
/**
 * Safely parse JSON string
 */
declare function safeJsonParse(json: string, defaultValue?: any): any;
/**
 * Safely stringify JSON
 */
declare function safeJsonStringify(obj: any, defaultValue?: string): string;
/**
 * Check if a message is a tool result submission
 */
declare function isToolResultSubmission(messages: Message[]): boolean;
/**
 * Format error message for display
 */
declare function formatErrorMessage(error: any): string;
/**
 * Truncate text to a maximum length
 */
declare function truncateText(text: string, maxLength?: number): string;
/**
 * Merge consecutive text blocks
 */
declare function mergeTextBlocks(blocks: Array<{
    type: string;
    text?: string;
}>): string;

export { type CallToolResult, ClaudeAgent, type ClaudeAgentConfig, type ClaudeSDKClient, type ContentBlock, type ConvertedMessage, EventTranslator, ExecutionState, ExecutionStateManager, type ExecutionState$1 as ExecutionStateType, type McpSdkServerConfigWithInstance, type Options, type ProcessedEvents, type Query, type SDKAssistantMessage, type SDKCompactBoundaryMessage, type SDKMessage, type SDKPartialAssistantMessage, type SDKPermissionDenial, type SDKResultMessage, type SDKSystemMessage, type SDKUserMessage, type SdkMcpToolDefinition, type Session, SessionManager, type TextBlock, type ThinkingBlock, ToolAdapter, type ToolExecutionContext, type ToolResultBlock, type ToolUseBlock, convertAgUiMessageToClaude, convertAgUiMessagesToClaude, convertAgUiMessagesToPrompt, extractMessageContent, extractToolResults, formatErrorMessage, generateMessageId, generateRunId, hasContentProperty, hasToolResults, isAssistantMessage, isResultMessage, isTextBlock, isThinkingBlock, isToolResultBlock, isToolResultSubmission, isToolUseBlock, mergeTextBlocks, safeJsonParse, safeJsonStringify, truncateText };
