/**
 * Session manager tests
 */

import { SessionManager } from '../src/session-manager';
import type { Message } from '@ag-ui/client';

describe('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    SessionManager.resetInstance();
    sessionManager = SessionManager.getInstance();
  });

  afterEach(() => {
    SessionManager.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = SessionManager.getInstance();
      const instance2 = SessionManager.getInstance();

      expect(instance1).toBe(instance2);
    });
  });

  describe('getSession', () => {
    it('should create new session if not exists', () => {
      const session = sessionManager.getSession('session1');

      expect(session.id).toBe('session1');
      expect(session.processedMessageIds).toBeDefined();
      expect(session.state).toEqual({});
    });

    it('should return existing session', () => {
      const session1 = sessionManager.getSession('session1');
      const session2 = sessionManager.getSession('session1');

      expect(session1).toBe(session2);
    });

    it('should update last accessed time', () => {
      const session1 = sessionManager.getSession('session1');
      const time1 = session1.lastAccessedAt;

      // Wait a bit
      setTimeout(() => {
        const session2 = sessionManager.getSession('session1');
        expect(session2.lastAccessedAt).toBeGreaterThanOrEqual(time1);
      }, 10);
    });
  });

  describe('hasSession', () => {
    it('should return true for existing session', () => {
      sessionManager.getSession('session1');
      expect(sessionManager.hasSession('session1')).toBe(true);
    });

    it('should return false for non-existing session', () => {
      expect(sessionManager.hasSession('session1')).toBe(false);
    });
  });

  describe('deleteSession', () => {
    it('should delete session', () => {
      sessionManager.getSession('session1');
      expect(sessionManager.hasSession('session1')).toBe(true);

      sessionManager.deleteSession('session1');
      expect(sessionManager.hasSession('session1')).toBe(false);
    });
  });

  describe('trackMessage', () => {
    it('should track processed message', () => {
      sessionManager.getSession('session1');
      sessionManager.trackMessage('session1', 'msg1');

      expect(sessionManager.isMessageProcessed('session1', 'msg1')).toBe(true);
    });
  });

  describe('isMessageProcessed', () => {
    it('should return false for unprocessed message', () => {
      sessionManager.getSession('session1');
      expect(sessionManager.isMessageProcessed('session1', 'msg1')).toBe(false);
    });

    it('should return true for processed message', () => {
      sessionManager.getSession('session1');
      sessionManager.trackMessage('session1', 'msg1');
      expect(sessionManager.isMessageProcessed('session1', 'msg1')).toBe(true);
    });
  });

  describe('getUnseenMessages', () => {
    it('should return all messages for new session', () => {
      const messages: Message[] = [
        { id: 'msg1', role: 'user', content: 'Hello' },
        { id: 'msg2', role: 'assistant', content: 'Hi' },
      ];

      const unseen = sessionManager.getUnseenMessages('session1', messages);
      expect(unseen).toHaveLength(2);
    });

    it('should filter out processed messages', () => {
      sessionManager.getSession('session1');
      sessionManager.trackMessage('session1', 'msg1');

      const messages: Message[] = [
        { id: 'msg1', role: 'user', content: 'Hello' },
        { id: 'msg2', role: 'assistant', content: 'Hi' },
      ];

      const unseen = sessionManager.getUnseenMessages('session1', messages);
      expect(unseen).toHaveLength(1);
      expect(unseen[0].id).toBe('msg2');
    });
  });

  describe('markMessagesAsProcessed', () => {
    it('should mark all messages as processed', () => {
      sessionManager.getSession('session1');

      const messages: Message[] = [
        { id: 'msg1', role: 'user', content: 'Hello' },
        { id: 'msg2', role: 'assistant', content: 'Hi' },
      ];

      sessionManager.markMessagesAsProcessed('session1', messages);

      expect(sessionManager.isMessageProcessed('session1', 'msg1')).toBe(true);
      expect(sessionManager.isMessageProcessed('session1', 'msg2')).toBe(true);
    });
  });

  describe('getStateValue', () => {
    it('should return state value', () => {
      sessionManager.getSession('session1');
      sessionManager.setStateValue('session1', 'key1', 'value1');

      expect(sessionManager.getStateValue('session1', 'key1')).toBe('value1');
    });

    it('should return undefined for non-existing key', () => {
      sessionManager.getSession('session1');
      expect(sessionManager.getStateValue('session1', 'key1')).toBeUndefined();
    });
  });

  describe('setStateValue', () => {
    it('should set state value', () => {
      sessionManager.getSession('session1');
      sessionManager.setStateValue('session1', 'key1', 'value1');

      expect(sessionManager.getStateValue('session1', 'key1')).toBe('value1');
    });
  });

  describe('removeStateKeys', () => {
    it('should remove state keys', () => {
      sessionManager.getSession('session1');
      sessionManager.setStateValue('session1', 'key1', 'value1');
      sessionManager.setStateValue('session1', 'key2', 'value2');

      sessionManager.removeStateKeys('session1', ['key1']);

      expect(sessionManager.getStateValue('session1', 'key1')).toBeUndefined();
      expect(sessionManager.getStateValue('session1', 'key2')).toBe('value2');
    });
  });

  describe('clearSessionState', () => {
    it('should clear all state', () => {
      sessionManager.getSession('session1');
      sessionManager.setStateValue('session1', 'key1', 'value1');
      sessionManager.setStateValue('session1', 'key2', 'value2');

      sessionManager.clearSessionState('session1');

      expect(sessionManager.getStateValue('session1', 'key1')).toBeUndefined();
      expect(sessionManager.getStateValue('session1', 'key2')).toBeUndefined();
    });
  });

  describe('getSessionCount', () => {
    it('should return session count', () => {
      expect(sessionManager.getSessionCount()).toBe(0);

      sessionManager.getSession('session1');
      expect(sessionManager.getSessionCount()).toBe(1);

      sessionManager.getSession('session2');
      expect(sessionManager.getSessionCount()).toBe(2);
    });
  });

  describe('getUserSessionCount', () => {
    it('should return user session count', () => {
      sessionManager.getSession('session1', 'user1');
      sessionManager.getSession('session2', 'user1');
      sessionManager.getSession('session3', 'user2');

      expect(sessionManager.getUserSessionCount('user1')).toBe(2);
      expect(sessionManager.getUserSessionCount('user2')).toBe(1);
    });
  });

  describe('getAllSessionIds', () => {
    it('should return all session IDs', () => {
      sessionManager.getSession('session1');
      sessionManager.getSession('session2');

      const ids = sessionManager.getAllSessionIds();
      expect(ids).toHaveLength(2);
      expect(ids).toContain('session1');
      expect(ids).toContain('session2');
    });
  });

  describe('getUserSessions', () => {
    it('should return user sessions', () => {
      sessionManager.getSession('session1', 'user1');
      sessionManager.getSession('session2', 'user1');
      sessionManager.getSession('session3', 'user2');

      const userSessions = sessionManager.getUserSessions('user1');
      expect(userSessions).toHaveLength(2);
    });
  });

  describe('clearAllSessions', () => {
    it('should clear all sessions', () => {
      sessionManager.getSession('session1');
      sessionManager.getSession('session2');

      sessionManager.clearAllSessions();

      expect(sessionManager.getSessionCount()).toBe(0);
    });
  });
});

