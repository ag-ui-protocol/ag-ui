"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __defProps = Object.defineProperties;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropDescs = Object.getOwnPropertyDescriptors;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __knownSymbol = (name, symbol) => (symbol = Symbol[name]) ? symbol : Symbol.for("Symbol." + name);
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __spreadProps = (a, b) => __defProps(a, __getOwnPropDescs(b));
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var __forAwait = (obj, it, method) => (it = obj[__knownSymbol("asyncIterator")]) ? it.call(obj) : (obj = obj[__knownSymbol("iterator")](), it = {}, method = (key, fn) => (fn = obj[key]) && (it[key] = (arg) => new Promise((yes, no, done) => (arg = fn.call(obj, arg), done = arg.done, Promise.resolve(arg.value).then((value) => yes({ value, done }), no)))), method("next"), method("return"), it);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  ClaudeAgent: () => ClaudeAgent,
  EventTranslator: () => EventTranslator,
  ExecutionState: () => ExecutionState,
  ExecutionStateManager: () => ExecutionStateManager,
  SessionManager: () => SessionManager,
  ToolAdapter: () => ToolAdapter,
  convertAgUiMessageToClaude: () => convertAgUiMessageToClaude,
  convertAgUiMessagesToClaude: () => convertAgUiMessagesToClaude,
  convertAgUiMessagesToPrompt: () => convertAgUiMessagesToPrompt,
  extractMessageContent: () => extractMessageContent,
  extractToolResults: () => extractToolResults,
  formatErrorMessage: () => formatErrorMessage,
  generateMessageId: () => generateMessageId,
  generateRunId: () => generateRunId,
  hasContentProperty: () => hasContentProperty,
  hasToolResults: () => hasToolResults,
  isAssistantMessage: () => isAssistantMessage,
  isResultMessage: () => isResultMessage,
  isTextBlock: () => isTextBlock,
  isThinkingBlock: () => isThinkingBlock,
  isToolResultBlock: () => isToolResultBlock,
  isToolResultSubmission: () => isToolResultSubmission,
  isToolUseBlock: () => isToolUseBlock,
  mergeTextBlocks: () => mergeTextBlocks,
  safeJsonParse: () => safeJsonParse,
  safeJsonStringify: () => safeJsonStringify,
  truncateText: () => truncateText
});
module.exports = __toCommonJS(src_exports);

// src/agent.ts
var import_rxjs = require("rxjs");
var import_client2 = require("@ag-ui/client");

// src/session-manager.ts
var DEFAULT_SESSION_TIMEOUT = 30 * 60 * 1e3;
var CLEANUP_INTERVAL = 5 * 60 * 1e3;
var _SessionManager = class _SessionManager {
  constructor(sessionTimeout = DEFAULT_SESSION_TIMEOUT) {
    this.sessions = /* @__PURE__ */ new Map();
    this.cleanupInterval = null;
    this.sessionTimeout = sessionTimeout;
    this.startCleanupInterval();
  }
  /**
   * Get the singleton instance
   */
  static getInstance(sessionTimeout) {
    if (!_SessionManager.instance) {
      _SessionManager.instance = new _SessionManager(sessionTimeout);
    }
    return _SessionManager.instance;
  }
  /**
   * Reset the singleton instance (useful for testing)
   */
  static resetInstance() {
    if (_SessionManager.instance) {
      _SessionManager.instance.stopCleanupInterval();
      _SessionManager.instance = null;
    }
  }
  /**
   * Get or create a session
   */
  getSession(sessionId, userId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        userId,
        processedMessageIds: /* @__PURE__ */ new Set(),
        state: {},
        createdAt: Date.now(),
        lastAccessedAt: Date.now()
      };
      this.sessions.set(sessionId, session);
    } else {
      session.lastAccessedAt = Date.now();
    }
    return session;
  }
  /**
   * Check if a session exists
   */
  hasSession(sessionId) {
    return this.sessions.has(sessionId);
  }
  /**
   * Delete a session
   */
  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session == null ? void 0 : session.client) {
      session.client.close().catch((error) => {
        console.error(`Error closing Claude SDK client for session ${sessionId}:`, error);
      });
    }
    return this.sessions.delete(sessionId);
  }
  /**
   * Track a processed message
   */
  trackMessage(sessionId, messageId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.processedMessageIds.add(messageId);
      session.lastAccessedAt = Date.now();
    }
  }
  /**
   * Check if a message has been processed
   */
  isMessageProcessed(sessionId, messageId) {
    const session = this.sessions.get(sessionId);
    return session ? session.processedMessageIds.has(messageId) : false;
  }
  /**
   * Get unseen messages (messages not yet processed)
   */
  getUnseenMessages(sessionId, messages) {
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
  markMessagesAsProcessed(sessionId, messages) {
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
  getStateValue(sessionId, key) {
    const session = this.sessions.get(sessionId);
    return session == null ? void 0 : session.state[key];
  }
  /**
   * Set state value in session
   */
  setStateValue(sessionId, key, value) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state[key] = value;
      session.lastAccessedAt = Date.now();
    }
  }
  /**
   * Remove state keys from session
   */
  removeStateKeys(sessionId, keys) {
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
  clearSessionState(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.state = {};
      session.lastAccessedAt = Date.now();
    }
  }
  /**
   * Set Claude SDK client for a session
   */
  setClient(sessionId, client) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.client = client;
      session.lastAccessedAt = Date.now();
    }
  }
  /**
   * Get Claude SDK client for a session
   */
  getClient(sessionId) {
    const session = this.sessions.get(sessionId);
    return session == null ? void 0 : session.client;
  }
  /**
   * Get total number of sessions
   */
  getSessionCount() {
    return this.sessions.size;
  }
  /**
   * Get number of sessions for a specific user
   */
  getUserSessionCount(userId) {
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
  getAllSessionIds() {
    return Array.from(this.sessions.keys());
  }
  /**
   * Get all sessions for a specific user
   */
  getUserSessions(userId) {
    const userSessions = [];
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
  cleanupStaleSessions() {
    const now = Date.now();
    const sessionsToDelete = [];
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
  startCleanupInterval() {
    if (!this.cleanupInterval) {
      this.cleanupInterval = setInterval(() => {
        this.cleanupStaleSessions();
      }, CLEANUP_INTERVAL);
      if (typeof this.cleanupInterval.unref === "function") {
        this.cleanupInterval.unref();
      }
    }
  }
  /**
   * Stop the cleanup interval
   */
  stopCleanupInterval() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
  /**
   * Clear all sessions (useful for testing)
   */
  clearAllSessions() {
    for (const sessionId of this.sessions.keys()) {
      this.deleteSession(sessionId);
    }
    this.sessions.clear();
  }
};
_SessionManager.instance = null;
var SessionManager = _SessionManager;

// src/event-translator.ts
var import_client = require("@ag-ui/client");

// src/types.ts
function isAssistantMessage(message) {
  return message.type === "assistant";
}
function isResultMessage(message) {
  return message.type === "result";
}
function isTextBlock(block) {
  return block.type === "text";
}
function isToolUseBlock(block) {
  return block.type === "tool_use";
}
function isToolResultBlock(block) {
  return block.type === "tool_result";
}
function isThinkingBlock(block) {
  return block.type === "thinking";
}
function hasContentProperty(message) {
  if (message.type === "assistant") {
    return "message" in message && message.message !== null && typeof message.message === "object" && "content" in message.message && Array.isArray(message.message.content);
  }
  return "content" in message && Array.isArray(message.content);
}

// src/event-translator.ts
var EventTranslator = class {
  constructor(runId, threadId) {
    this.messageIdCounter = 0;
    this.currentMessageId = null;
    this.runId = runId;
    this.threadId = threadId;
  }
  /**
   * Translate a Claude SDK message to AG-UI events
   * NOTE: Does not emit RUN_STARTED, RUN_FINISHED, or STEP events - those are handled by ClaudeAgent
   */
  translateMessage(message) {
    const events = [];
    if (hasContentProperty(message)) {
      events.push(...this.translateAssistantMessage(message));
    }
    return events;
  }
  /**
   * Translate an AssistantMessage with content blocks
   */
  translateAssistantMessage(message) {
    var _a;
    const events = [];
    const content = ((_a = message.message) == null ? void 0 : _a.content) || [];
    for (const block of content) {
      if (isTextBlock(block)) {
        events.push(...this.translateTextBlock(block));
      } else if (isToolUseBlock(block)) {
        events.push(...this.translateToolUseBlock(block));
      } else if (isToolResultBlock(block)) {
        events.push(...this.translateToolResultBlock(block));
      }
    }
    return events;
  }
  /**
   * Translate a TextBlock to text message events
   * NOTE: Step events are handled by ClaudeAgent, not here
   */
  translateTextBlock(block) {
    const events = [];
    const messageId = this.generateMessageId();
    events.push({
      type: import_client.EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant"
    });
    const text = block.text;
    if (text.length > 0) {
      events.push({
        type: import_client.EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: text
      });
    }
    events.push({
      type: import_client.EventType.TEXT_MESSAGE_END,
      messageId
    });
    return events;
  }
  /**
   * Translate a ToolUseBlock to tool call events
   * NOTE: Step events are handled by ClaudeAgent, not here
   */
  translateToolUseBlock(block) {
    const events = [];
    const toolCallId = block.id;
    events.push({
      type: import_client.EventType.TOOL_CALL_START,
      toolCallId,
      toolCallName: block.name
    });
    const argsJson = JSON.stringify(block.input);
    if (argsJson.length > 0) {
      events.push({
        type: import_client.EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: argsJson
      });
    }
    events.push({
      type: import_client.EventType.TOOL_CALL_END,
      toolCallId
    });
    return events;
  }
  /**
   * Translate a ToolResultBlock to tool call result event
   */
  translateToolResultBlock(block) {
    const events = [];
    let resultContent;
    if (typeof block.content === "string") {
      resultContent = block.content;
    } else if (Array.isArray(block.content)) {
      resultContent = block.content.map((item) => {
        if (item.type === "text") {
          return item.text || "";
        }
        return JSON.stringify(item);
      }).join("\n");
    } else {
      resultContent = JSON.stringify(block.content);
    }
    const messageId = this.generateMessageId();
    events.push(__spreadValues({
      type: import_client.EventType.TOOL_CALL_RESULT,
      toolCallId: block.tool_use_id,
      messageId,
      content: resultContent
    }, block.is_error && { role: "tool" }));
    return events;
  }
  /**
   * Generate a unique message ID
   */
  generateMessageId() {
    this.messageIdCounter++;
    return `msg_${this.runId}_${this.messageIdCounter}`;
  }
  /**
   * Reset the translator state for a new execution
   */
  reset() {
    this.messageIdCounter = 0;
    this.currentMessageId = null;
  }
  /**
   * Get current message ID
   */
  getCurrentMessageId() {
    return this.currentMessageId;
  }
  /**
   * Set current message ID
   */
  setCurrentMessageId(messageId) {
    this.currentMessageId = messageId;
  }
};

// src/tool-adapter.ts
var import_zod = require("zod");
var ToolAdapter = class {
  /**
   * Convert AG-UI tools to Claude SDK MCP tool definitions
   */
  static convertAgUiToolsToSdk(tools) {
    return tools.map((tool) => this.convertSingleTool(tool));
  }
  /**
   * Convert a single AG-UI tool to Claude SDK format
   */
  static convertSingleTool(tool) {
    const zodSchema = this.convertJsonSchemaToZod(tool.parameters || {});
    return {
      name: tool.name,
      description: tool.description || "",
      inputSchema: zodSchema,
      handler: async (args) => {
        if (tool.client) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  toolName: tool.name,
                  args,
                  isClientTool: true,
                  isLongRunning: true
                })
              }
            ]
          };
        }
        if (tool.handler) {
          try {
            const result = await tool.handler(args);
            return {
              content: [
                {
                  type: "text",
                  text: typeof result === "string" ? result : JSON.stringify(result)
                }
              ]
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: error.message || "Tool execution failed"
                }
              ],
              isError: true
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: "Tool executed (no handler)"
            }
          ]
        };
      }
    };
  }
  /**
   * Convert JSON Schema to Zod schema
   */
  static convertJsonSchemaToZod(jsonSchema) {
    if (!jsonSchema || typeof jsonSchema !== "object") {
      return import_zod.z.object({});
    }
    const properties = jsonSchema.properties || {};
    const required = jsonSchema.required || [];
    const zodShape = {};
    for (const [key, prop] of Object.entries(properties)) {
      const propSchema = prop;
      let zodType = this.convertJsonSchemaTypeToZod(propSchema);
      if (!required.includes(key)) {
        zodType = zodType.optional();
      }
      zodShape[key] = zodType;
    }
    return import_zod.z.object(zodShape);
  }
  /**
   * Convert a single JSON Schema type to Zod type
   */
  static convertJsonSchemaTypeToZod(schema) {
    const type = schema.type;
    switch (type) {
      case "string":
        if (schema.enum) {
          return import_zod.z.enum(schema.enum);
        }
        return import_zod.z.string();
      case "number":
      case "integer":
        let numType = type === "integer" ? import_zod.z.number().int() : import_zod.z.number();
        if (schema.minimum !== void 0) {
          numType = numType.min(schema.minimum);
        }
        if (schema.maximum !== void 0) {
          numType = numType.max(schema.maximum);
        }
        return numType;
      case "boolean":
        return import_zod.z.boolean();
      case "array":
        if (schema.items) {
          const itemType = this.convertJsonSchemaTypeToZod(schema.items);
          return import_zod.z.array(itemType);
        }
        return import_zod.z.array(import_zod.z.any());
      case "object":
        if (schema.properties) {
          return this.convertJsonSchemaToZod(schema);
        }
        return import_zod.z.record(import_zod.z.any());
      case "null":
        return import_zod.z.null();
      default:
        return import_zod.z.any();
    }
  }
  /**
   * Create an MCP server configuration for AG-UI tools
   */
  static async createMcpServerForTools(tools) {
    const sdkTools = this.convertAgUiToolsToSdk(tools);
    const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk");
    return createSdkMcpServer({
      name: "ag_ui_tools",
      version: "1.0.0",
      tools: sdkTools
      // Cast to any to avoid type incompatibility
    });
  }
  /**
   * Extract tool calls from Claude SDK response
   */
  static extractToolCalls(message) {
    if (!message.content || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.filter((block) => block.type === "tool_use").map((block) => ({
      id: block.id,
      name: block.name,
      input: block.input
    }));
  }
  /**
   * Check if a tool is a long-running client tool
   */
  static isClientTool(toolName, tools) {
    const tool = tools.find((t) => t.name === toolName);
    return (tool == null ? void 0 : tool.client) === true;
  }
  /**
   * Check if a tool is marked as long-running
   */
  static isLongRunningTool(toolName, tools) {
    const tool = tools.find((t) => t.name === toolName);
    return (tool == null ? void 0 : tool.client) === true || (tool == null ? void 0 : tool.longRunning) === true;
  }
  /**
   * Format tool names for Claude SDK (with MCP server prefix)
   */
  static formatToolNameForSdk(toolName, serverName = "ag_ui_tools") {
    return `mcp__${serverName}__${toolName}`;
  }
  /**
   * Parse tool name from SDK format (remove MCP server prefix)
   */
  static parseToolNameFromSdk(sdkToolName) {
    const parts = sdkToolName.split("__");
    if (parts.length >= 3 && parts[0] === "mcp") {
      return parts.slice(2).join("__");
    }
    return sdkToolName;
  }
  /**
   * Get allowed tools list for SDK options
   */
  static getAllowedToolsList(tools, serverName = "ag_ui_tools") {
    return tools.map((tool) => this.formatToolNameForSdk(tool.name, serverName));
  }
};

// src/execution-state.ts
var ExecutionState = class {
  constructor(id, sessionId) {
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
  get isRunning() {
    return this._isRunning;
  }
  /**
   * Get start time
   */
  get startTime() {
    return this._startTime;
  }
  /**
   * Get end time
   */
  get endTime() {
    return this._endTime;
  }
  /**
   * Get duration in milliseconds
   */
  get duration() {
    const end = this._endTime || Date.now();
    return end - this._startTime;
  }
  /**
   * Get all collected events
   */
  get events() {
    return [...this._events];
  }
  /**
   * Get error if any
   */
  get error() {
    return this._error;
  }
  /**
   * Get abort signal
   */
  get signal() {
    return this._abortController.signal;
  }
  /**
   * Add an event to the execution state
   */
  addEvent(event) {
    this._events.push(event);
  }
  /**
   * Add multiple events
   */
  addEvents(events) {
    this._events.push(...events);
  }
  /**
   * Mark execution as completed
   */
  complete() {
    if (this._isRunning) {
      this._isRunning = false;
      this._endTime = Date.now();
    }
  }
  /**
   * Mark execution as failed
   */
  fail(error) {
    if (this._isRunning) {
      this._isRunning = false;
      this._endTime = Date.now();
      this._error = error;
    }
  }
  /**
   * Abort the execution
   */
  abort() {
    if (this._isRunning) {
      this._abortController.abort();
      this._isRunning = false;
      this._endTime = Date.now();
    }
  }
  /**
   * Get execution statistics
   */
  getStats() {
    return {
      duration: this.duration,
      eventCount: this._events.length,
      isRunning: this._isRunning,
      hasError: !!this._error
    };
  }
  /**
   * Clear events (useful for memory management)
   */
  clearEvents() {
    this._events = [];
  }
  /**
   * Get the last N events
   */
  getLastEvents(count) {
    return this._events.slice(-count);
  }
  /**
   * Check if execution has been aborted
   */
  isAborted() {
    return this._abortController.signal.aborted;
  }
};
var ExecutionStateManager = class {
  constructor(maxExecutions = 100) {
    this.executions = /* @__PURE__ */ new Map();
    this.maxExecutions = maxExecutions;
  }
  /**
   * Create a new execution state
   */
  createExecution(id, sessionId) {
    const execution = new ExecutionState(id, sessionId);
    this.executions.set(id, execution);
    if (this.executions.size > this.maxExecutions) {
      this.cleanupOldExecutions();
    }
    return execution;
  }
  /**
   * Get an execution state by ID
   */
  getExecution(id) {
    return this.executions.get(id);
  }
  /**
   * Check if an execution exists
   */
  hasExecution(id) {
    return this.executions.has(id);
  }
  /**
   * Delete an execution state
   */
  deleteExecution(id) {
    return this.executions.delete(id);
  }
  /**
   * Get all executions for a session
   */
  getSessionExecutions(sessionId) {
    const executions = [];
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
  getRunningExecutions() {
    const running = [];
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
  getCompletedExecutions() {
    const completed = [];
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
  abortSessionExecutions(sessionId) {
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
  cleanupOldExecutions() {
    const completed = this.getCompletedExecutions();
    completed.sort((a, b) => {
      const aTime = a.endTime || a.startTime;
      const bTime = b.endTime || b.startTime;
      return aTime - bTime;
    });
    const toRemove = Math.max(0, this.executions.size - this.maxExecutions);
    for (let i = 0; i < toRemove && i < completed.length; i++) {
      this.executions.delete(completed[i].id);
    }
  }
  /**
   * Clear all executions
   */
  clearAll() {
    this.executions.clear();
  }
  /**
   * Get total execution count
   */
  getExecutionCount() {
    return this.executions.size;
  }
  /**
   * Get execution statistics
   */
  getStats() {
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
      failed
    };
  }
};

// src/utils/converters.ts
function convertAgUiMessagesToPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      return extractMessageContent(msg);
    }
  }
  return "Hello";
}
function extractMessageContent(message) {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content.map((block) => {
      if (typeof block === "string") {
        return block;
      }
      if (block.type === "text") {
        return block.text || "";
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  return String(message.content);
}
function convertAgUiMessageToClaude(message) {
  const role = message.role;
  const content = extractMessageContent(message);
  return {
    role,
    content
  };
}
function convertAgUiMessagesToClaude(messages) {
  return messages.map(convertAgUiMessageToClaude);
}
function hasToolResults(messages) {
  return messages.some((msg) => {
    if (typeof msg.content === "string") {
      return false;
    }
    if (Array.isArray(msg.content)) {
      return msg.content.some((block) => {
        return typeof block === "object" && block.type === "tool_result";
      });
    }
    return false;
  });
}
function extractToolResults(messages) {
  const results = [];
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      continue;
    }
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (typeof block === "object" && block.type === "tool_result") {
          results.push({
            toolCallId: block.toolCallId || block.tool_use_id || "",
            result: block.result || block.content || ""
          });
        }
      }
    }
  }
  return results;
}
function generateRunId() {
  return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
function generateMessageId(prefix = "msg") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}
function safeJsonParse(json, defaultValue = null) {
  try {
    return JSON.parse(json);
  } catch (e) {
    return defaultValue;
  }
}
function safeJsonStringify(obj, defaultValue = "{}") {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return defaultValue;
  }
}
function isToolResultSubmission(messages) {
  if (messages.length === 0) {
    return false;
  }
  const lastMessage = messages[messages.length - 1];
  return hasToolResults([lastMessage]);
}
function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred";
}
function truncateText(text, maxLength = 1e3) {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength) + "...";
}
function mergeTextBlocks(blocks) {
  return blocks.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("");
}

// src/agent.ts
var ClaudeAgent = class extends import_client2.AbstractAgent {
  constructor(config) {
    super(config);
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.sessionTimeout = config.sessionTimeout || 30 * 60 * 1e3;
    this.enablePersistentSessions = config.enablePersistentSessions !== false;
    this.permissionMode = this.mapPermissionMode(config.permissionMode || "bypassPermissions");
    this.stderr = config.stderr;
    this.verbose = config.verbose;
    this.sessionManager = SessionManager.getInstance(this.sessionTimeout);
    this.executionStateManager = new ExecutionStateManager();
  }
  /**
   * Map legacy permission modes to new SDK values for backward compatibility
   */
  mapPermissionMode(mode) {
    const modeMap = {
      "ask": "default",
      "auto": "bypassPermissions",
      "none": "bypassPermissions",
      "default": "default",
      "acceptEdits": "acceptEdits",
      "bypassPermissions": "bypassPermissions",
      "plan": "plan"
    };
    return modeMap[mode || "bypassPermissions"] || "bypassPermissions";
  }
  /**
   * Run the agent with the given input
   */
  run(input) {
    return new import_rxjs.Observable((subscriber) => {
      this.executeAgent(input, subscriber).catch((error) => {
        subscriber.error(error);
      });
    });
  }
  /**
   * Execute the agent asynchronously
   */
  async executeAgent(input, subscriber) {
    const runId = generateRunId();
    const sessionId = input.threadId || `session_${Date.now()}`;
    const execution = this.executionStateManager.createExecution(runId, sessionId);
    try {
      const runStartedEvent = {
        type: import_client2.EventType.RUN_STARTED,
        threadId: sessionId,
        runId
      };
      subscriber.next(runStartedEvent);
      execution.addEvent(runStartedEvent);
      const session = this.sessionManager.getSession(sessionId, "default");
      const unseenMessages = this.sessionManager.getUnseenMessages(
        sessionId,
        input.messages || []
      );
      const isToolResult = isToolResultSubmission(input.messages || []);
      const tools = input.tools || [];
      const options = await this.prepareClaudeOptions(tools);
      const prompt = convertAgUiMessagesToPrompt(unseenMessages);
      const stepStartedEvent = {
        type: import_client2.EventType.STEP_STARTED,
        stepName: `step_${runId}_1`
      };
      subscriber.next(stepStartedEvent);
      execution.addEvent(stepStartedEvent);
      await this.callClaudeSDK(
        prompt,
        options,
        session,
        runId,
        sessionId,
        subscriber,
        execution
      );
      this.sessionManager.markMessagesAsProcessed(sessionId, unseenMessages);
      const stepFinishedEvent = {
        type: import_client2.EventType.STEP_FINISHED,
        stepName: `step_${runId}_1`
      };
      subscriber.next(stepFinishedEvent);
      execution.addEvent(stepFinishedEvent);
      const runFinishedEvent = {
        type: import_client2.EventType.RUN_FINISHED,
        threadId: sessionId,
        runId
      };
      subscriber.next(runFinishedEvent);
      execution.addEvent(runFinishedEvent);
      execution.complete();
      subscriber.complete();
    } catch (error) {
      const runErrorEvent = {
        type: import_client2.EventType.RUN_ERROR,
        message: formatErrorMessage(error)
      };
      subscriber.next(runErrorEvent);
      execution.addEvent(runErrorEvent);
      execution.fail(error);
      subscriber.complete();
    }
  }
  /**
   * Prepare Claude SDK options
   * SDK automatically reads ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY from environment
   * But baseUrl needs to be explicitly passed for third-party APIs
   */
  async prepareClaudeOptions(tools) {
    const baseUrl = this.baseUrl || process.env.ANTHROPIC_BASE_URL;
    const apiKey = this.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    console.log("[Claude Agent] Preparing SDK options:", {
      hasApiKey: !!apiKey,
      hasBaseUrl: !!baseUrl,
      baseUrl: baseUrl || "not set",
      permissionMode: this.permissionMode,
      hasStderr: !!this.stderr,
      verbose: this.verbose
    });
    const options = __spreadProps(__spreadValues(__spreadValues({
      permissionMode: this.permissionMode
    }, this.stderr && { stderr: this.stderr }), this.verbose !== void 0 && { verbose: this.verbose }), {
      env: process.env
    });
    if (this.stderr) {
      console.log("[Claude Agent] \u2713 stderr callback is configured for error logging");
    } else {
      console.warn("[Claude Agent] \u26A0\uFE0F  stderr callback not configured - CLI errors may not be visible");
    }
    if (tools && tools.length > 0) {
      const mcpServer = await ToolAdapter.createMcpServerForTools(tools);
      options.mcpServers = {
        ag_ui_tools: mcpServer
      };
      options.allowedTools = ToolAdapter.getAllowedToolsList(tools);
    }
    return options;
  }
  /**
   * Call Claude SDK
   * Note: Currently only stateless mode is supported via query() function
   */
  async callClaudeSDK(prompt, options, session, runId, sessionId, subscriber, execution) {
    const eventTranslator = new EventTranslator(runId, sessionId);
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
  async callClaudeSDKPersistent(prompt, options, session, eventTranslator, subscriber, execution) {
    await this.callClaudeSDKStateless(prompt, options, eventTranslator, subscriber, execution);
  }
  /**
   * Call Claude SDK in stateless mode
   */
  async callClaudeSDKStateless(prompt, options, eventTranslator, subscriber, execution) {
    try {
      console.log("[Claude Agent] Environment check:");
      console.log("  ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "SET" : "NOT SET");
      console.log("  ANTHROPIC_AUTH_TOKEN:", process.env.ANTHROPIC_AUTH_TOKEN ? "SET" : "NOT SET");
      console.log("  ANTHROPIC_BASE_URL:", process.env.ANTHROPIC_BASE_URL || "NOT SET (using default)");
      console.log("[Claude Agent] Options passed to SDK:", {
        hasApiKey: !!options.apiKey,
        hasBaseUrl: !!options.baseUrl,
        permissionMode: options.permissionMode,
        hasMcpServers: !!options.mcpServers
      });
      const { query } = await this.importClaudeSDK();
      console.log("[Claude Agent] Calling SDK query()...");
      const queryResult = query({ prompt, options });
      try {
        for (var iter = __forAwait(queryResult), more, temp, error; more = !(temp = await iter.next()).done; more = false) {
          const message = temp.value;
          console.log("[Claude Agent] \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
          console.log("[Claude Agent] Received message type:", (message == null ? void 0 : message.type) || "unknown");
          console.log("[Claude Agent] Full message:", JSON.stringify(message, null, 2));
          if (execution.isAborted()) {
            console.log("[Claude Agent] Execution aborted by user");
            break;
          }
          const events = eventTranslator.translateMessage(message);
          console.log("[Claude Agent] Translated events count:", events.length);
          for (const event of events) {
            console.log("[Claude Agent] Sending event:", JSON.stringify(event, null, 2));
            subscriber.next(event);
            execution.addEvent(event);
          }
          console.log("[Claude Agent] \u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501");
        }
      } catch (temp) {
        error = [temp];
      } finally {
        try {
          more && (temp = iter.return) && await temp.call(iter);
        } finally {
          if (error)
            throw error[0];
        }
      }
      console.log("[Claude Agent] Query completed successfully");
    } catch (error2) {
      console.error("[Claude Agent] ERROR Details:");
      console.error("  Message:", error2.message);
      console.error("  Stack:", error2.stack);
      console.error("  Error object:", JSON.stringify(error2, Object.getOwnPropertyNames(error2), 2));
      if (error2.message && error2.message.includes("exited with code")) {
        throw new Error(
          `Claude Code process failed. Please ensure:
1. Claude CLI is installed and accessible (run: claude --version)
2. ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set correctly in environment variables
3. You have proper permissions to run Claude Code
4. If using ANTHROPIC_BASE_URL, ensure it supports Claude Code protocol

Original error: ${error2.message}
Error stack: ${error2.stack || "No stack trace"}`
        );
      }
      if (error2.message && (error2.message.includes("API key") || error2.message.includes("auth"))) {
        throw new Error(
          `API key error: ${error2.message}
Please ensure ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN is set in environment variables.`
        );
      }
      throw error2;
    }
  }
  /**
   * Dynamically import Claude SDK
   */
  async importClaudeSDK() {
    try {
      return await import("@anthropic-ai/claude-agent-sdk");
    } catch (error) {
      throw new Error(
        "Claude Agent SDK not found. Please install it: npm install @anthropic-ai/claude-agent-sdk"
      );
    }
  }
  /**
   * Abort a running execution
   */
  abortExecution(runId) {
    const execution = this.executionStateManager.getExecution(runId);
    if (execution) {
      execution.abort();
    }
  }
  /**
   * Get execution state
   */
  getExecutionState(runId) {
    return this.executionStateManager.getExecution(runId);
  }
  /**
   * Get session manager (for testing)
   */
  getSessionManager() {
    return this.sessionManager;
  }
  /**
   * Get execution state manager (for testing)
   */
  getExecutionStateManager() {
    return this.executionStateManager;
  }
  /**
   * Cleanup resources
   */
  async cleanup() {
    const runningExecutions = this.executionStateManager.getRunningExecutions();
    for (const execution of runningExecutions) {
      execution.abort();
    }
    this.sessionManager.clearAllSessions();
    this.executionStateManager.clearAll();
  }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ClaudeAgent,
  EventTranslator,
  ExecutionState,
  ExecutionStateManager,
  SessionManager,
  ToolAdapter,
  convertAgUiMessageToClaude,
  convertAgUiMessagesToClaude,
  convertAgUiMessagesToPrompt,
  extractMessageContent,
  extractToolResults,
  formatErrorMessage,
  generateMessageId,
  generateRunId,
  hasContentProperty,
  hasToolResults,
  isAssistantMessage,
  isResultMessage,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolResultSubmission,
  isToolUseBlock,
  mergeTextBlocks,
  safeJsonParse,
  safeJsonStringify,
  truncateText
});
//# sourceMappingURL=index.js.map