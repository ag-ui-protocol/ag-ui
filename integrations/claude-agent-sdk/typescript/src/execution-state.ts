/**
 * Execution state: Tracks background Claude executions
 */

import type { ProcessedEvents } from './types';

/**
 * ExecutionState manages the state of a Claude SDK execution
 */
export class ExecutionState {
  readonly id: string;
  readonly sessionId: string;
  private _isRunning: boolean;
  private _startTime: number;
  private _endTime?: number;
  private _events: ProcessedEvents[];
  private _error?: Error;
  private _abortController: AbortController;

  constructor(id: string, sessionId: string) {
    this.id = id;
    this.sessionId = sessionId;
    this._isRunning = true;
    this._startTime = Date.now();
    this._events = [];
    this._abortController = new AbortController();
  }

  /**
   * Check if execution is running
   */
  get isRunning(): boolean {
    return this._isRunning;
  }

  /**
   * Get start time
   */
  get startTime(): number {
    return this._startTime;
  }

  /**
   * Get end time
   */
  get endTime(): number | undefined {
    return this._endTime;
  }

  /**
   * Get duration in milliseconds
   */
  get duration(): number {
    const end = this._endTime || Date.now();
    return end - this._startTime;
  }

  /**
   * Get all collected events
   */
  get events(): ProcessedEvents[] {
    return [...this._events];
  }

  /**
   * Get error if any
   */
  get error(): Error | undefined {
    return this._error;
  }

  /**
   * Get abort signal
   */
  get signal(): AbortSignal {
    return this._abortController.signal;
  }

  /**
   * Add an event to the execution state
   */
  addEvent(event: ProcessedEvents): void {
    this._events.push(event);
  }

  /**
   * Add multiple events
   */
  addEvents(events: ProcessedEvents[]): void {
    this._events.push(...events);
  }

  /**
   * Mark execution as completed
   */
  complete(): void {
    if (this._isRunning) {
      this._isRunning = false;
      this._endTime = Date.now();
    }
  }

  /**
   * Mark execution as failed
   */
  fail(error: Error): void {
    if (this._isRunning) {
      this._isRunning = false;
      this._endTime = Date.now();
      this._error = error;
    }
  }

  /**
   * Abort the execution
   */
  abort(): void {
    if (this._isRunning) {
      this._abortController.abort();
      this._isRunning = false;
      this._endTime = Date.now();
    }
  }

  /**
   * Get execution statistics
   */
  getStats(): {
    duration: number;
    eventCount: number;
    isRunning: boolean;
    hasError: boolean;
  } {
    return {
      duration: this.duration,
      eventCount: this._events.length,
      isRunning: this._isRunning,
      hasError: !!this._error,
    };
  }

  /**
   * Clear events (useful for memory management)
   */
  clearEvents(): void {
    this._events = [];
  }

  /**
   * Get the last N events
   */
  getLastEvents(count: number): ProcessedEvents[] {
    return this._events.slice(-count);
  }

  /**
   * Check if execution has been aborted
   */
  isAborted(): boolean {
    return this._abortController.signal.aborted;
  }
}

/**
 * ExecutionStateManager manages multiple execution states
 */
export class ExecutionStateManager {
  private executions: Map<string, ExecutionState> = new Map();
  private readonly maxExecutions: number;

  constructor(maxExecutions: number = 100) {
    this.maxExecutions = maxExecutions;
  }

  /**
   * Create a new execution state
   */
  createExecution(id: string, sessionId: string): ExecutionState {
    const execution = new ExecutionState(id, sessionId);
    this.executions.set(id, execution);

    // Clean up old executions if we exceed the limit
    if (this.executions.size > this.maxExecutions) {
      this.cleanupOldExecutions();
    }

    return execution;
  }

  /**
   * Get an execution state by ID
   */
  getExecution(id: string): ExecutionState | undefined {
    return this.executions.get(id);
  }

  /**
   * Check if an execution exists
   */
  hasExecution(id: string): boolean {
    return this.executions.has(id);
  }

  /**
   * Delete an execution state
   */
  deleteExecution(id: string): boolean {
    return this.executions.delete(id);
  }

  /**
   * Get all executions for a session
   */
  getSessionExecutions(sessionId: string): ExecutionState[] {
    const executions: ExecutionState[] = [];
    for (const execution of this.executions.values()) {
      if (execution.sessionId === sessionId) {
        executions.push(execution);
      }
    }
    return executions;
  }

  /**
   * Get running executions
   */
  getRunningExecutions(): ExecutionState[] {
    const running: ExecutionState[] = [];
    for (const execution of this.executions.values()) {
      if (execution.isRunning) {
        running.push(execution);
      }
    }
    return running;
  }

  /**
   * Get completed executions
   */
  getCompletedExecutions(): ExecutionState[] {
    const completed: ExecutionState[] = [];
    for (const execution of this.executions.values()) {
      if (!execution.isRunning) {
        completed.push(execution);
      }
    }
    return completed;
  }

  /**
   * Abort all running executions for a session
   */
  abortSessionExecutions(sessionId: string): void {
    const sessionExecutions = this.getSessionExecutions(sessionId);
    for (const execution of sessionExecutions) {
      if (execution.isRunning) {
        execution.abort();
      }
    }
  }

  /**
   * Clean up old completed executions
   */
  private cleanupOldExecutions(): void {
    const completed = this.getCompletedExecutions();
    
    // Sort by end time (oldest first)
    completed.sort((a, b) => {
      const aTime = a.endTime || a.startTime;
      const bTime = b.endTime || b.startTime;
      return aTime - bTime;
    });

    // Remove the oldest executions
    const toRemove = Math.max(0, this.executions.size - this.maxExecutions);
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      this.executions.delete(completed[i].id);
    }
  }

  /**
   * Clear all executions
   */
  clearAll(): void {
    this.executions.clear();
  }

  /**
   * Get total execution count
   */
  getExecutionCount(): number {
    return this.executions.size;
  }

  /**
   * Get execution statistics
   */
  getStats(): {
    total: number;
    running: number;
    completed: number;
    failed: number;
  } {
    let running = 0;
    let completed = 0;
    let failed = 0;

    for (const execution of this.executions.values()) {
      if (execution.isRunning) {
        running++;
      } else if (execution.error) {
        failed++;
      } else {
        completed++;
      }
    }

    return {
      total: this.executions.size,
      running,
      completed,
      failed,
    };
  }
}

