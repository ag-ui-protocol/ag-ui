# CopilotKit + Claude Agent SDK Integration Demo

这个示例展示了如何使用 AG-UI Protocol 将 Claude Agent SDK 集成到 CopilotKit 中。

## 架构图

```
┌─────────────────────────────────────┐
│  CopilotKit Frontend (React/Next.js) │
│  - CopilotChat UI                    │
│  - Frontend Tools                    │
└──────────────┬──────────────────────┘
               │ HTTP/SSE
               ↓
┌─────────────────────────────────────┐
│  CopilotKit Runtime (Next.js API)    │
│  - HttpAgent (@ag-ui/client)         │
│  - CopilotRuntime                    │
└──────────────┬──────────────────────┘
               │ AG-UI Protocol
               ↓
┌─────────────────────────────────────┐
│  Claude Agent SDK Server (FastAPI)   │
│  - AG-UI Protocol Endpoint           │
│  - ClaudeAgent                       │
└──────────────┬──────────────────────┘
               │
               ↓
┌─────────────────────────────────────┐
│  Claude Agent SDK (Python)           │
│  - ClaudeSDKClient                   │
│  - Multi-turn Conversations          │
└─────────────────────────────────────┘
```

## 快速开始

### 1. 启动 Claude Agent SDK 服务器

在一个终端中：

```bash
cd ../../python/examples/server
python fastapi_server.py
```

服务器将在 `http://localhost:8000/chat` 运行。

### 2. 安装并启动 CopilotKit 前端

在另一个终端中：

```bash
cd integrations/claude-agent-sdk/typescript/examples/copilotkit
npm install
npm run dev
```

前端将在 `http://localhost:3000` 运行。

### 3. 打开浏览器

访问 `http://localhost:3000` 查看 CopilotKit 聊天界面。

## 功能特性

- ✅ **持续对话**: 使用 `ClaudeSDKClient` 维护对话历史
- ✅ **工具支持**: Claude 可以调用前端工具
- ✅ **流式响应**: 通过 Server-Sent Events 实时流式传输
- ✅ **会话管理**: 跨多个请求的持久会话
- ✅ **完整功能**: 支持中断、钩子、自定义工具（使用 `ClaudeSDKClient` 时）

## 目录结构

```
copilotkit/
├── src/
│   └── app/
│       ├── api/
│       │   └── copilotkit/
│       │       └── route.ts        # CopilotKit 运行时端点
│       ├── layout.tsx              # Next.js 布局
│       ├── page.tsx                # 前端聊天界面
│       └── globals.css             # 全局样式
├── package.json                    # 依赖配置
├── tsconfig.json                   # TypeScript 配置
├── next.config.js                  # Next.js 配置
├── tailwind.config.js              # Tailwind CSS 配置
├── postcss.config.js               # PostCSS 配置
└── README.md                       # 详细文档
```

## 工作原理

### 1. 前端 (React + CopilotKit)

`src/app/page.tsx` 使用 CopilotKit 的 React 组件：
- `CopilotKit`: 包装应用并连接到运行时
- `CopilotChat`: 提供聊天 UI
- `useFrontendTool`: 定义 Claude 可以调用的前端工具

### 2. API 路由 (Next.js)

`src/app/api/copilotkit/route.ts`:
- 创建指向 Claude Agent SDK 服务器的 `HttpAgent` (来自 `@ag-ui/client`)
- 将其包装在 `CopilotRuntime` 中
- 暴露 CopilotKit 调用的 POST 端点

### 3. 后端 (Claude Agent SDK)

Claude Agent SDK 服务器 (`../../python/examples/server/fastapi_server.py`):
- 处理 AG-UI Protocol 请求
- 将它们转换为 Claude Agent SDK 调用
- 返回 AG-UI Protocol 事件
- 支持 CORS 以便前端集成

## 环境变量

- `CLAUDE_AGENT_URL`: Claude Agent SDK 服务器的 URL (默认: `http://localhost:8000/chat`)

## 故障排除

1. **连接错误**: 确保 Claude Agent SDK 服务器在正确的端口运行
2. **CORS 问题**: FastAPI 服务器包含 CORS 中间件。如果需要添加更多源，请编辑 `fastapi_server.py`
3. **Agent 未找到**: 检查前端的 agent ID (`agentic_chat`) 是否与 API 路由中的匹配

## 参考文档

- [CopilotKit 文档](https://docs.copilotkit.ai/adk/quickstart?path=exiting-agent)
- [AG-UI Protocol 文档](https://ag-ui-protocol.github.io/ag-ui/)
- [Claude Agent SDK 文档](https://docs.claude.com/zh-CN/api/agent-sdk/python)
