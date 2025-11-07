# @ag-ui/claude

Claude Agent SDK 与 AG-UI Protocol 的集成，让 Claude 代理能够无缝工作在 AG-UI 应用中。

## 特性

- ✅ **完整的 AG-UI Protocol 支持** - 实现所有标准事件类型
- ✅ **持久会话管理** - 支持多轮对话和会话状态维护
- ✅ **工具集成** - 支持客户端和后端工具
- ✅ **流式响应** - 实时流式传输 AI 响应
- ✅ **无状态模式** - 可选的无状态执行模式
- ✅ **TypeScript 支持** - 完整的类型定义
- ✅ **可观察对象 API** - 基于 RxJS Observable 的事件流
- ✅ **自动会话清理** - 自动清理过期会话

## 安装

```bash
npm install @ag-ui/claude @ag-ui/client @ag-ui/core
```

还需要安装 Claude Agent SDK：

```bash
npm install @anthropic-ai/claude-agent-sdk
```

## 快速开始

### 基础用法

```typescript
import { ClaudeAgent } from '@ag-ui/claude';
import type { RunAgentInput } from '@ag-ui/client';

// 初始化 agent
const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
  enablePersistentSessions: true,
});

// 准备输入
const input: RunAgentInput = {
  agentId: 'my_agent',
  threadId: 'thread_123',
  messages: [
    { id: 'msg_1', role: 'user', content: 'Hello!' },
  ],
  context: {},
};

// 运行 agent 并订阅事件
agent.run(input).subscribe({
  next: (event) => {
    console.log('Event:', event);
  },
  error: (error) => {
    console.error('Error:', error);
  },
  complete: () => {
    console.log('Done!');
  },
});
```

### 使用工具

```typescript
import { ClaudeAgent } from '@ag-ui/claude';

const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const input: RunAgentInput = {
  agentId: 'my_agent',
  messages: [
    { id: 'msg_1', role: 'user', content: 'Calculate 42 + 58' },
  ],
  context: {
    tools: [
      {
        name: 'calculator',
        description: 'Performs calculations',
        parameters: {
          type: 'object',
          properties: {
            operation: { type: 'string' },
            a: { type: 'number' },
            b: { type: 'number' },
          },
          required: ['operation', 'a', 'b'],
        },
        handler: async ({ operation, a, b }) => {
          // 后端工具实现
          if (operation === 'add') return a + b;
          // ...
        },
      },
    ],
  },
};

agent.run(input).subscribe({
  next: (event) => {
    if (event.type === 'tool_call_start') {
      console.log('Tool called:', event.toolName);
    }
  },
});
```

### Express 服务器示例

```typescript
import express from 'express';
import { ClaudeAgent } from '@ag-ui/claude';

const app = express();
app.use(express.json());

const agent = new ClaudeAgent({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.post('/api/run-agent', async (req, res) => {
  const input: RunAgentInput = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');

  agent.run(input).subscribe({
    next: (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    error: (error) => {
      res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
      res.end();
    },
    complete: () => {
      res.end();
    },
  });
});

app.listen(3000);
```

## API 文档

### ClaudeAgent

主要的 agent 类，继承自 `AbstractAgent`。

#### 构造函数

```typescript
constructor(config: ClaudeAgentConfig)
```

**配置选项：**

- `apiKey?: string` - Anthropic API 密钥（默认从 `ANTHROPIC_API_KEY` 环境变量读取）
- `baseUrl?: string` - API 基础 URL（默认从 `ANTHROPIC_BASE_URL` 环境变量读取）
- `enablePersistentSessions?: boolean` - 是否启用持久会话（默认：`true`）
- `sessionTimeout?: number` - 会话超时时间（毫秒，默认：30 分钟）
- `permissionMode?: 'ask' | 'auto' | 'none'` - 权限模式（默认：`'ask'`）

#### 方法

##### `run(input: RunAgentInput): Observable<ProcessedEvents>`

运行 agent 并返回事件流的 Observable。

**参数：**
- `input.agentId: string` - Agent ID
- `input.threadId?: string` - 会话 ID（用于持久会话）
- `input.messages: Message[]` - 消息历史
- `input.context?: { tools?: Tool[] }` - 上下文（包括工具定义）

**返回：** Observable，发出 AG-UI Protocol 事件

##### `abortExecution(runId: string): void`

中止正在运行的执行。

##### `cleanup(): Promise<void>`

清理所有会话和资源。

### SessionManager

会话管理器，采用单例模式。

#### 方法

- `getInstance(sessionTimeout?: number): SessionManager` - 获取单例实例
- `getSession(sessionId: string, userId?: string): Session` - 获取或创建会话
- `hasSession(sessionId: string): boolean` - 检查会话是否存在
- `deleteSession(sessionId: string): boolean` - 删除会话
- `trackMessage(sessionId: string, messageId: string): void` - 标记消息已处理
- `getUnseenMessages(sessionId: string, messages: Message[]): Message[]` - 获取未处理的消息
- `getStateValue(sessionId: string, key: string): any` - 获取会话状态值
- `setStateValue(sessionId: string, key: string, value: any): void` - 设置会话状态值

### EventTranslator

事件转换器，将 Claude SDK 消息转换为 AG-UI 事件。

#### 方法

- `translateMessage(message: SDKMessage): ProcessedEvents[]` - 转换单个消息

### ToolAdapter

工具适配器，处理工具格式转换。

#### 静态方法

- `convertAgUiToolsToSdk(tools: Tool[]): SdkMcpToolDefinition[]` - 转换工具到 SDK 格式
- `createMcpServerForTools(tools: Tool[]): McpSdkServerConfigWithInstance` - 创建 MCP 服务器
- `formatToolNameForSdk(toolName: string, serverName?: string): string` - 格式化工具名称
- `parseToolNameFromSdk(sdkToolName: string): string` - 解析工具名称

## 事件类型

agent 发出以下 AG-UI Protocol 事件：

- `RunStartedEvent` - 执行开始
- `RunFinishedEvent` - 执行完成
- `RunErrorEvent` - 执行错误
- `StepStartedEvent` - 步骤开始
- `StepFinishedEvent` - 步骤完成
- `TextMessageStartEvent` - 文本消息开始
- `TextMessageContentEvent` - 文本消息内容（流式）
- `TextMessageEndEvent` - 文本消息结束
- `ToolCallStartEvent` - 工具调用开始
- `ToolCallArgsEvent` - 工具参数
- `ToolCallEndEvent` - 工具调用结束
- `ToolCallResultEvent` - 工具执行结果

## 工具支持

### 后端工具

后端工具在服务器端执行：

```typescript
{
  name: 'calculator',
  description: 'Performs calculations',
  parameters: { /* JSON Schema */ },
  handler: async (args) => {
    // 工具逻辑
    return result;
  }
}
```

### 客户端工具

客户端工具在前端执行，设置 `client: true`：

```typescript
{
  name: 'file_reader',
  description: 'Reads files',
  client: true,
  parameters: { /* JSON Schema */ }
}
```

## 会话管理

### 持久会话模式

启用持久会话后，agent 会为每个 `threadId` 维护独立的会话：

```typescript
const agent = new ClaudeAgent({
  apiKey: 'your_key',
  enablePersistentSessions: true,
  sessionTimeout: 30 * 60 * 1000, // 30 分钟
});
```

### 无状态模式

禁用持久会话后，每次调用都是独立的：

```typescript
const agent = new ClaudeAgent({
  apiKey: 'your_key',
  enablePersistentSessions: false,
});
```

## 测试

运行单元测试：

```bash
npm test
```

运行特定测试：

```bash
npm test -- agent.test.ts
```

## 示例

查看 `examples/` 目录获取完整的示例：

- **Express Server** - 完整的 Express.js 服务器示例
- **工具集成** - 后端和客户端工具示例
- **会话管理** - 多轮对话示例

## 架构

集成架构基于 Python 版本：

```
AG-UI Protocol          Claude Middleware          Claude Agent SDK
     │                        │                           │
RunAgentInput ──────> ClaudeAgent.run() ──────> SDK Client/Query
     │                        │                           │
     │                 EventTranslator                    │
     │                        │                           │
BaseEvent[] <──────── translate events <──────── Response[]
```

主要组件：

- **ClaudeAgent**: 主协调器，管理执行流程
- **EventTranslator**: 事件转换（Claude SDK → AG-UI）
- **SessionManager**: 会话生命周期管理
- **ToolAdapter**: 工具格式转换
- **ExecutionState**: 执行状态跟踪

## 参考

- [Python 实现](../python/) - Python SDK 实现参考
- [Claude Agent SDK 文档](https://docs.claude.com/zh-CN/api/agent-sdk/typescript)
- [AG-UI Protocol 文档](https://docs.ag-ui.com/)

## 许可证

Apache-2.0

