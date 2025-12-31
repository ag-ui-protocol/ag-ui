/**
 * Claude Agent SDK integration with AG-UI Protocol
 * 
 * This package provides a bridge between Claude Agent SDK and the AG-UI Protocol,
 * enabling Claude agents to work seamlessly with AG-UI applications.
 * 
 * @example
 * ```typescript
 * import { ClaudeAgent } from '@ag-ui/claude';
 * 
 * const agent = new ClaudeAgent({
 *   apiKey: process.env.ANTHROPIC_API_KEY,
 *   enablePersistentSessions: true
 * });
 * 
 * agent.run(input).subscribe({
 *   next: (event) => console.log(event),
 *   error: (error) => console.error(error),
 *   complete: () => console.log('Done')
 * });
 * ```
 */

// Main agent class
export { ClaudeAgent } from './agent';

// Session management
export { SessionManager } from './session-manager';

// Event translation
export { EventTranslator } from './event-translator';

// Tool adaptation
export { ToolAdapter } from './tool-adapter';

// Execution state management
export { ExecutionState, ExecutionStateManager } from './execution-state';

// Utility functions
export {
  convertAgUiMessagesToPrompt,
  convertAgUiMessageToClaude,
  convertAgUiMessagesToClaude,
  extractMessageContent,
  hasToolResults,
  extractToolResults,
  generateRunId,
  generateMessageId,
  safeJsonParse,
  safeJsonStringify,
  isToolResultSubmission,
  formatErrorMessage,
  truncateText,
  mergeTextBlocks,
} from './utils/converters';

// Type exports
export type {
  ClaudeAgentConfig,
  ProcessedEvents,
  Session,
  ClaudeSDKClient,
  Options,
  Query,
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKPermissionDenial,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  SdkMcpToolDefinition,
  CallToolResult,
  McpSdkServerConfigWithInstance,
  ExecutionState as ExecutionStateType,
  ToolExecutionContext,
  ConvertedMessage,
} from './types';

// Re-export type guards
export {
  isAssistantMessage,
  isResultMessage,
  isTextBlock,
  isToolUseBlock,
  isToolResultBlock,
  isThinkingBlock,
  hasContentProperty,
} from './types';

