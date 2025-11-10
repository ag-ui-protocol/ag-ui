/**
 * Claude Agent: Main agent class that integrates Claude SDK with AG-UI Protocol
 */

import { Observable, Subscriber } from 'rxjs';
import {
  AbstractAgent,
  RunAgentInput,
  EventType,
  RunStartedEvent,
  RunFinishedEvent,
  RunErrorEvent,
  StepStartedEvent,
  StepFinishedEvent,
} from '@ag-ui/client';
import type {
  ClaudeAgentConfig,
  ProcessedEvents,
  ClaudeSDKClient,
  Options,
  SDKMessage,
} from './types';
import { SessionManager } from './session-manager';
import { EventTranslator } from './event-translator';
import { ToolAdapter } from './tool-adapter';
import { ExecutionState, ExecutionStateManager } from './execution-state';
import {
  generateRunId,
  convertAgUiMessagesToPrompt,
  isToolResultSubmission,
  formatErrorMessage,
} from './utils/converters';

/**
 * ClaudeAgent integrates Claude Agent SDK with AG-UI Protocol
 */
export class ClaudeAgent extends AbstractAgent {
  private sessionManager: SessionManager;
  private executionStateManager: ExecutionStateManager;
  private apiKey?: string;
  private baseUrl?: string;
  private sessionTimeout: number;
  private enablePersistentSessions: boolean;
  private permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  private stderr?: (data: string) => void;
  private verbose?: boolean;

  constructor(config: ClaudeAgentConfig) {
    super(config);
    // SDK automatically reads ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
    // Only set these if explicitly provided in config (optional)
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.sessionTimeout = config.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.enablePersistentSessions = config.enablePersistentSessions !== false;
    // Map legacy permission modes to new SDK values for backward compatibility
    this.permissionMode = this.mapPermissionMode(config.permissionMode || 'bypassPermissions');
    this.stderr = config.stderr;
    this.verbose = config.verbose;
    this.sessionManager = SessionManager.getInstance(this.sessionTimeout);
    this.executionStateManager = new ExecutionStateManager();
  }

  /**
   * Map legacy permission modes to new SDK values for backward compatibility
   */
  private mapPermissionMode(mode?: string): 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' {
    const modeMap: Record<string, 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'> = {
      'ask': 'default',
      'auto': 'bypassPermissions',
      'none': 'bypassPermissions',
      'default': 'default',
      'acceptEdits': 'acceptEdits',
      'bypassPermissions': 'bypassPermissions',
      'plan': 'plan',
    };
    return modeMap[mode || 'bypassPermissions'] || 'bypassPermissions';
  }

  /**
   * Run the agent with the given input
   */
  run(input: RunAgentInput): Observable<ProcessedEvents> {
    return new Observable((subscriber) => {
      this.executeAgent(input, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }

  /**
   * Execute the agent asynchronously
   */
  private async executeAgent(
    input: RunAgentInput,
    subscriber: Subscriber<ProcessedEvents>
  ): Promise<void> {
    const runId = generateRunId();
    const sessionId = input.threadId || `session_${Date.now()}`;

    // Create execution state
    const execution = this.executionStateManager.createExecution(runId, sessionId);

    try {
      // Emit run started event
      const runStartedEvent: RunStartedEvent = {
        type: EventType.RUN_STARTED,
        threadId: sessionId,
        runId,
      };
      subscriber.next(runStartedEvent);
      execution.addEvent(runStartedEvent);

      // Get or create session
      const session = this.sessionManager.getSession(sessionId, 'default');

      // Get unseen messages
      const unseenMessages = this.sessionManager.getUnseenMessages(
        sessionId,
        input.messages || []
      );

      // Check if this is a tool result submission
      const isToolResult = isToolResultSubmission(input.messages || []);

      // Prepare tools
      const tools = input.tools || [];
      
      // Prepare options for Claude SDK
      const options = await this.prepareClaudeOptions(tools);

      // Extract prompt from messages
      const prompt = convertAgUiMessagesToPrompt(unseenMessages);

      // Emit step started event
      const stepStartedEvent: StepStartedEvent = {
        type: EventType.STEP_STARTED,
        stepName: `step_${runId}_1`,
      };
      subscriber.next(stepStartedEvent);
      execution.addEvent(stepStartedEvent);

      // Call Claude SDK
      await this.callClaudeSDK(
        prompt,
        options,
        session,
        runId,
        sessionId,
        subscriber,
        execution
      );

      // Mark messages as processed
      this.sessionManager.markMessagesAsProcessed(sessionId, unseenMessages);

      // Emit step finished event
      const stepFinishedEvent: StepFinishedEvent = {
        type: EventType.STEP_FINISHED,
        stepName: `step_${runId}_1`,
      };
      subscriber.next(stepFinishedEvent);
      execution.addEvent(stepFinishedEvent);

      // Emit run finished event
      const runFinishedEvent: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
        threadId: sessionId,
        runId,
      };
      subscriber.next(runFinishedEvent);
      execution.addEvent(runFinishedEvent);

      // Complete execution
      execution.complete();
      subscriber.complete();
    } catch (error: any) {
      // Emit run error event
      const runErrorEvent: RunErrorEvent = {
        type: EventType.RUN_ERROR,
        message: formatErrorMessage(error),
      };
      subscriber.next(runErrorEvent);
      execution.addEvent(runErrorEvent);

      // Mark execution as failed
      execution.fail(error);

      // Complete the observable
      subscriber.complete();
    }
  }

  /**
   * Prepare Claude SDK options
   * SDK automatically reads ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
   * But baseUrl needs to be explicitly passed for third-party APIs
   */
  private async prepareClaudeOptions(tools: any[]): Promise<Options> {
    // Get baseUrl from config or environment
    const baseUrl = this.baseUrl || process.env.ANTHROPIC_BASE_URL;
    const apiKey = this.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    
    // Debug logging
    console.log('[Claude Agent] Preparing SDK options:', {
      hasApiKey: !!apiKey,
      hasBaseUrl: !!baseUrl,
      baseUrl: baseUrl || 'not set',
      permissionMode: this.permissionMode,
      hasStderr: !!this.stderr,
      verbose: this.verbose,
    });
    
    const options: Options = {
      permissionMode: this.permissionMode,
      // Add stderr callback for debugging - CRITICAL for error logging
      ...(this.stderr && { stderr: this.stderr }),
      // Add verbose flag for detailed logging
      ...(this.verbose !== undefined && { verbose: this.verbose }),
      env: process.env
    };
    
    // Verify stderr callback is set
    if (this.stderr) {
      console.log('[Claude Agent] ✓ stderr callback is configured for error logging');
    } else {
      console.warn('[Claude Agent] ⚠️  stderr callback not configured - CLI errors may not be visible');
    }

    // Add tools if provided
    if (tools && tools.length > 0) {
      const mcpServer = await ToolAdapter.createMcpServerForTools(tools);
      options.mcpServers = {
        ag_ui_tools: mcpServer,
      };

      // Set allowed tools
      options.allowedTools = ToolAdapter.getAllowedToolsList(tools);
    }

    return options;
  }

  /**
   * Call Claude SDK
   * Note: Currently only stateless mode is supported via query() function
   */
  private async callClaudeSDK(
    prompt: string,
    options: Options,
    session: any,
    runId: string,
    sessionId: string,
    subscriber: Subscriber<ProcessedEvents>,
    execution: ExecutionState
  ): Promise<void> {
    const eventTranslator = new EventTranslator(runId, sessionId);

    // The current @anthropic-ai/claude-agent-sdk only supports stateless mode
    // via the query() function. We use stateless mode for both cases.
    await this.callClaudeSDKStateless(
      prompt,
      options,
      eventTranslator,
      subscriber,
      execution
    );
  }

  /**
   * Call Claude SDK in persistent session mode
   * Note: The current SDK only supports stateless mode via query() function
   * This method falls back to stateless mode
   */
  private async callClaudeSDKPersistent(
    prompt: string,
    options: Options,
    session: any,
    eventTranslator: EventTranslator,
    subscriber: Subscriber<ProcessedEvents>,
    execution: ExecutionState
  ): Promise<void> {
    // The current @anthropic-ai/claude-agent-sdk only supports stateless mode
    // via the query() function. For persistent sessions, we use query() 
    // but maintain session state in our SessionManager
    await this.callClaudeSDKStateless(prompt, options, eventTranslator, subscriber, execution);
  }

  /**
   * Call Claude SDK in stateless mode
   */
  private async callClaudeSDKStateless(
    prompt: string,
    options: Options,
    eventTranslator: EventTranslator,
    subscriber: Subscriber<ProcessedEvents>,
    execution: ExecutionState
  ): Promise<void> {
    try {
      // Log environment variables for debugging
      console.log('[Claude Agent] Environment check:');
      console.log('  ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'SET' : 'NOT SET');
      console.log('  ANTHROPIC_AUTH_TOKEN:', process.env.ANTHROPIC_AUTH_TOKEN ? 'SET' : 'NOT SET');
      console.log('  ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL || 'NOT SET (using default)');
      console.log('[Claude Agent] Options passed to SDK:', {
        hasApiKey: !!options.apiKey,
        hasBaseUrl: !!options.baseUrl,
        permissionMode: options.permissionMode,
        hasMcpServers: !!options.mcpServers,
      });

      // Import Claude SDK dynamically
      const { query } = await this.importClaudeSDK();

      console.log('[Claude Agent] Calling SDK query()...');

      // Call query function
      // SDK will automatically read API key from environment variables (ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN)
      // if not provided in options.apiKey
      const queryResult = query({ prompt, options });

      // Process responses
      for await (const message of queryResult) {
        console.log('[Claude Agent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('[Claude Agent] Received message type:', message?.type || 'unknown');
        console.log('[Claude Agent] Full message:', JSON.stringify(message, null, 2));
        
        if (execution.isAborted()) {
          console.log('[Claude Agent] Execution aborted by user');
          break;
        }

        const events = eventTranslator.translateMessage(message);
        console.log('[Claude Agent] Translated events count:', events.length);
        for (const event of events) {
          console.log('[Claude Agent] Sending event:', JSON.stringify(event, null, 2));
          subscriber.next(event);
          execution.addEvent(event);
        }
        console.log('[Claude Agent] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      }
      
      console.log('[Claude Agent] Query completed successfully');
    } catch (error: any) {
      // Log detailed error information
      console.error('[Claude Agent] ERROR Details:');
      console.error('  Message:', error.message);
      console.error('  Stack:', error.stack);
      console.error('  Error object:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
      
      // Handle Claude Code process errors
      if (error.message && error.message.includes('exited with code')) {
        throw new Error(
          `Claude Code process failed. Please ensure:\n` +
          `1. Claude CLI is installed and accessible (run: claude --version)\n` +
          `2. ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set correctly in environment variables\n` +
          `3. You have proper permissions to run Claude Code\n` +
          `4. If using ANTHROPIC_BASE_URL, ensure it supports Claude Code protocol\n` +
          `\nOriginal error: ${error.message}\n` +
          `Error stack: ${error.stack || 'No stack trace'}`
        );
      }
      // Handle API key errors from SDK
      if (error.message && (error.message.includes('API key') || error.message.includes('auth'))) {
        throw new Error(
          `API key error: ${error.message}\n` +
          `Please ensure ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set in environment variables.`
        );
      }
      throw error;
    }
  }

  /**
   * Dynamically import Claude SDK
   */
  private async importClaudeSDK(): Promise<any> {
    try {
      return await import('@anthropic-ai/claude-agent-sdk');
    } catch (error) {
      throw new Error(
        'Claude Agent SDK not found. Please install it: npm install @anthropic-ai/claude-agent-sdk'
      );
    }
  }

  /**
   * Abort a running execution
   */
  abortExecution(runId: string): void {
    const execution = this.executionStateManager.getExecution(runId);
    if (execution) {
      execution.abort();
    }
  }

  /**
   * Get execution state
   */
  getExecutionState(runId: string): ExecutionState | undefined {
    return this.executionStateManager.getExecution(runId);
  }

  /**
   * Get session manager (for testing)
   */
  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  /**
   * Get execution state manager (for testing)
   */
  getExecutionStateManager(): ExecutionStateManager {
    return this.executionStateManager;
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Abort all running executions
    const runningExecutions = this.executionStateManager.getRunningExecutions();
    for (const execution of runningExecutions) {
      execution.abort();
    }

    // Clear all sessions
    this.sessionManager.clearAllSessions();

    // Clear all executions
    this.executionStateManager.clearAll();
  }
}

