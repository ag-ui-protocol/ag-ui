/**
 * Session manager: Manages agent sessions and state
 */

import type { Message } from '@ag-ui/client';
import type { Session, ClaudeSDKClient } from './types';

const DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

/**
 * SessionManager handles session lifecycle, message tracking, and state management
 * Implements singleton pattern for centralized session control
 */
export class SessionManager {
  private static instance: SessionManager | null = null;
  private sessions: Map<string, Session> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  private sessionTimeout: number;

  private constructor(sessionTimeout: number = DEFAULT_SESSION_TIMEOUT) {
    this.sessionTimeout = sessionTimeout;
    this.startCleanupInterval();
  }

  /**
   * Get the singleton instance
   */
  static getInstance(sessionTimeout?: number): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager(sessionTimeout);
    }
    return SessionManager.instance;
  }

  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance(): void {
    if (SessionManager.instance) {
      SessionManager.instance.stopCleanupInterval();
      SessionManager.instance = null;
    }
  }

  /**
   * Get or create a session
   */
  getSession(sessionId: string, userId?: string): Session {
    let session = this.sessions.get(sessionId);

    if (!session) {
      session = {
        id: sessionId,
        userId,
        processedMessageIds: new Set<string>(),
        state: {},
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
    } else {
      // Update last accessed time
      session.lastAccessedAt = Date.now();
    }

    return session;
  }

  /**
   * Check if a session exists
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session?.client) {
      // Close the Claude SDK client if it exists
      session.client.close().catch((error) => {
        console.error(`Error closing Claude SDK client for session ${sessionId}:`, error);
      });
    }
    return this.sessions.delete(sessionId);
  }

  /**
   * Track a processed message
   */
  trackMessage(sessionId: string, messageId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.processedMessageIds.add(messageId);
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Check if a message has been processed
   */
  isMessageProcessed(sessionId: string, messageId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session ? session.processedMessageIds.has(messageId) : false;
  }

  /**
   * Get unseen messages (messages not yet processed)
   */
  getUnseenMessages(sessionId: string, messages: Message[]): Message[] {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return messages;
    }

    return messages.filter((msg) => {
      const msgId = msg.id || `${msg.role}_${msg.content}`;
      return !session.processedMessageIds.has(msgId);
    });
  }

  /**
   * Mark messages as processed
   */
  markMessagesAsProcessed(sessionId: string, messages: Message[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const msg of messages) {
        const msgId = msg.id || `${msg.role}_${msg.content}`;
        session.processedMessageIds.add(msgId);
      }
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Get state value from session
   */
  getStateValue(sessionId: string, key: string): any {
    const session = this.sessions.get(sessionId);
    return session?.state[key];
  }

  /**
   * Set state value in session
   */
  setStateValue(sessionId: string, key: string, value: any): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state[key] = value;
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Remove state keys from session
   */
  removeStateKeys(sessionId: string, keys: string[]): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      for (const key of keys) {
        delete session.state[key];
      }
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Clear all state for a session
   */
  clearSessionState(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = {};
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Set Claude SDK client for a session
   */
  setClient(sessionId: string, client: ClaudeSDKClient): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.client = client;
      session.lastAccessedAt = Date.now();
    }
  }

  /**
   * Get Claude SDK client for a session
   */
  getClient(sessionId: string): ClaudeSDKClient | undefined {
    const session = this.sessions.get(sessionId);
    return session?.client;
  }

  /**
   * Get total number of sessions
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get number of sessions for a specific user
   */
  getUserSessionCount(userId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Get all session IDs
   */
  getAllSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get all sessions for a specific user
   */
  getUserSessions(userId: string): Session[] {
    const userSessions: Session[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId === userId) {
        userSessions.push(session);
      }
    }
    return userSessions;
  }

  /**
   * Clean up stale sessions
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    const sessionsToDelete: string[] = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastAccessedAt > this.sessionTimeout) {
        sessionsToDelete.push(sessionId);
      }
    }

    for (const sessionId of sessionsToDelete) {
      this.deleteSession(sessionId);
    }

    if (sessionsToDelete.length > 0) {
      console.log(`Cleaned up ${sessionsToDelete.length} stale sessions`);
    }
  }

  /**
   * Start the cleanup interval
   */
  private startCleanupInterval(): void {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupStaleSessions();
      }, CLEANUP_INTERVAL);

      // Don't keep the process alive just for this interval
      if (typeof (this.cleanupInterval as any).unref === 'function') {
        (this.cleanupInterval as any).unref();
      }
    }
  }

  /**
   * Stop the cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all sessions (useful for testing)
   */
  clearAllSessions(): void {
    for (const sessionId of this.sessions.keys()) {
      this.deleteSession(sessionId);
    }
    this.sessions.clear();
  }
}

