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
  private permissionMode: 'ask' | 'auto' | 'none';

  constructor(config: ClaudeAgentConfig) {
    super(config);
    this.apiKey = config.apiKey || process.env.ANTHROPIC_API_KEY;
    this.baseUrl = config.baseUrl || process.env.ANTHROPIC_BASE_URL;
    this.sessionTimeout = config.sessionTimeout || 30 * 60 * 1000; // 30 minutes
    this.enablePersistentSessions = config.enablePersistentSessions !== false;
    this.permissionMode = config.permissionMode || 'ask';
    this.sessionManager = SessionManager.getInstance(this.sessionTimeout);
    this.executionStateManager = new ExecutionStateManager();
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
        runId,
      };
      subscriber.next(runStartedEvent);
      execution.addEvent(runStartedEvent);

      // Get or create session
      const session = this.sessionManager.getSession(sessionId, input.agentId);

      // Get unseen messages
      const unseenMessages = this.sessionManager.getUnseenMessages(
        sessionId,
        input.messages || []
      );

      // Check if this is a tool result submission
      const isToolResult = isToolResultSubmission(input.messages || []);

      // Prepare tools
      const tools = input.context?.tools || [];
      
      // Prepare options for Claude SDK
      const options = this.prepareClaudeOptions(tools);

      // Extract prompt from messages
      const prompt = convertAgUiMessagesToPrompt(unseenMessages);

      // Emit step started event
      const stepStartedEvent: StepStartedEvent = {
        type: EventType.STEP_STARTED,
        runId,
        stepId: `step_${runId}_1`,
      };
      subscriber.next(stepStartedEvent);
      execution.addEvent(stepStartedEvent);

      // Call Claude SDK
      await this.callClaudeSDK(
        prompt,
        options,
        session,
        runId,
        subscriber,
        execution
      );

      // Mark messages as processed
      this.sessionManager.markMessagesAsProcessed(sessionId, unseenMessages);

      // Emit step finished event
      const stepFinishedEvent: StepFinishedEvent = {
        type: EventType.STEP_FINISHED,
        runId,
        stepId: `step_${runId}_1`,
      };
      subscriber.next(stepFinishedEvent);
      execution.addEvent(stepFinishedEvent);

      // Emit run finished event
      const runFinishedEvent: RunFinishedEvent = {
        type: EventType.RUN_FINISHED,
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
        runId,
        error: formatErrorMessage(error),
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
   */
  private prepareClaudeOptions(tools: any[]): Options {
    const options: Options = {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      permissionMode: this.permissionMode,
    };

    // Add tools if provided
    if (tools && tools.length > 0) {
      const mcpServer = ToolAdapter.createMcpServerForTools(tools);
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
   */
  private async callClaudeSDK(
    prompt: string,
    options: Options,
    session: any,
    runId: string,
    subscriber: Subscriber<ProcessedEvents>,
    execution: ExecutionState
  ): Promise<void> {
    const eventTranslator = new EventTranslator(runId);

    if (this.enablePersistentSessions) {
      // Persistent session mode
      await this.callClaudeSDKPersistent(
        prompt,
        options,
        session,
        eventTranslator,
        subscriber,
        execution
      );
    } else {
      // Stateless mode
      await this.callClaudeSDKStateless(
        prompt,
        options,
        eventTranslator,
        subscriber,
        execution
      );
    }
  }

  /**
   * Call Claude SDK in persistent session mode
   */
  private async callClaudeSDKPersistent(
    prompt: string,
    options: Options,
    session: any,
    eventTranslator: EventTranslator,
    subscriber: Subscriber<ProcessedEvents>,
    execution: ExecutionState
  ): Promise<void> {
    // Get or create Claude SDK client
    let client = this.sessionManager.getClient(session.id);

    if (!client) {
      // Import Claude SDK dynamically
      const { ClaudeSDKClient } = await this.importClaudeSDK();
      client = new ClaudeSDKClient(options);
      this.sessionManager.setClient(session.id, client);
    }

    // Send query
    await client.query(prompt);

    // Receive and process responses
    for await (const message of client.receiveResponse()) {
      if (execution.isAborted()) {
        break;
      }

      const events = eventTranslator.translateMessage(message);
      for (const event of events) {
        subscriber.next(event);
        execution.addEvent(event);
      }
    }
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
    // Import Claude SDK dynamically
    const { query } = await this.importClaudeSDK();

    // Call query function
    const queryResult = query({ prompt, options });

    // Process responses
    for await (const message of queryResult) {
      if (execution.isAborted()) {
        break;
      }

      const events = eventTranslator.translateMessage(message);
      for (const event of events) {
        subscriber.next(event);
        execution.addEvent(event);
      }
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

