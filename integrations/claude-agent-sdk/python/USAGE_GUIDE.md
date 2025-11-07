# Claude Agent SDK 集成使用指南

本指南将帮助您快速启动和测试 Claude Agent SDK 与 AG-UI Protocol 的集成。

## 前置要求

1. **Python 3.9 或更高版本**
2. **Anthropic API Key** - 从 [Anthropic Console](https://console.anthropic.com/) 获取
3. **Git** - 用于克隆仓库（如果尚未克隆）

## 快速开始

### 1. 安装依赖

```bash
# 进入集成目录
cd integrations/claude-agent-sdk/python

# 创建虚拟环境（推荐）
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 安装包
pip install .
```

或者使用 `uv`：

```bash
uv pip install .
```

### 2. 配置 API Key

设置 Anthropic API Key 环境变量：

```bash
# Option 1: 使用 AUTH_TOKEN 和 BASE_URL（推荐）
export ANTHROPIC_AUTH_TOKEN=your-auth-token-here
export ANTHROPIC_BASE_URL=https://api.anthropic.com

# Option 2: 使用 API Key（后备方式）
export ANTHROPIC_API_KEY=your-api-key-here
```

### 3. 启动服务器

#### 方式 1: 直接运行示例服务器

```bash
cd examples/server
python fastapi_server.py
```

#### 方式 2: 使用 uvicorn

```bash
# 从项目根目录
uvicorn examples.server.fastapi_server:app --host 0.0.0.0 --port 8000

# 或者从 python 目录
cd integrations/claude-agent-sdk/python
uvicorn examples.server.fastapi_server:app --host 0.0.0.0 --port 8000
```

服务器启动后，您应该看到：

```
INFO:     Started server process [xxxxx]
INFO:     Waiting for application startup.
INFO:     Application startup complete.
INFO:     Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)
```

### 4. 验证服务器运行

服务器将在以下端点提供 AG-UI 协议支持：

- **AG-UI 端点**: `http://localhost:8000/chat`
- **API 文档**: `http://localhost:8000/docs` (FastAPI 自动生成的文档)

## 测试方法

### 方法 1: 使用 curl 测试（基础测试）

```bash
curl -X POST http://localhost:8000/chat \
  -H "Content-Type: application/json" \
  -d '{
    "threadId": "test-thread-1",
    "runId": "test-run-1",
    "messages": [
      {
        "id": "msg-1",
        "role": "user",
        "content": "Hello! Can you introduce yourself?"
      }
    ],
    "tools": [],
    "context": [],
    "state": {},
    "forwardedProps": {}
  }'
```

### 方法 2: 使用提供的测试脚本（推荐）

项目包含一个简单的测试脚本，可以直接使用：

```bash
# 安装依赖（如果需要）
pip install aiohttp

# 基本测试
python examples/test_client.py

# 交互式模式（推荐）
python examples/test_client.py --interactive

# 自定义服务器地址
python examples/test_client.py --server http://localhost:8001/chat
```

交互式模式允许您：
- 输入消息与 agent 对话
- 实时查看流式响应
- 输入 `quit` 或 `exit` 退出

### 方法 3: 使用 AG-UI TypeScript 客户端

如果您有 Node.js 环境，可以使用 AG-UI TypeScript 客户端：

```bash
# 安装依赖
cd apps/client-cli-example
pnpm install

# 修改 agent.ts 指向您的服务器
# 然后运行客户端
pnpm start
```

### 方法 4: 使用集成测试（开发测试）

项目包含完整的测试套件，可以直接运行：

```bash
# 从 python 目录运行所有测试
cd integrations/claude-agent-sdk/python
pytest

# 运行特定测试文件
pytest tests/test_integration_basic.py

# 运行真实 API 测试（需要配置 API Key）
pytest tests/test_real_api.py -m integration
```

## 使用工具

### 定义工具

AG-UI 工具会自动转换为 Claude SDK 格式。示例：

```python
from ag_ui.core import Tool
from ag_ui_claude import ClaudeAgent, add_claude_fastapi_endpoint
from fastapi import FastAPI

# 定义一个天气工具
weather_tool = Tool(
    name="get_current_weather",
    description="Get the current weather in a given location",
    parameters={
        "type": "object",
        "properties": {
            "location": {
                "type": "string",
                "description": "The city and state"
            },
            "unit": {
                "type": "string",
                "enum": ["celsius", "fahrenheit"]
            }
        },
        "required": ["location"]
    }
)

# 创建 agent 并添加工具
agent = ClaudeAgent(
    use_persistent_sessions=True,
    app_name="weather_app"
)

app = FastAPI()
add_claude_fastapi_endpoint(
    app, 
    agent, 
    path="/chat",
    tools=[weather_tool]  # 工具会自动转换
)
```

### 客户端工具 vs 服务器工具

- **客户端工具**: 由客户端执行的工具，通过 `ToolCall` 事件发送给客户端
- **服务器工具**: 在服务器端执行的工具，可以直接在 Claude SDK 中注册

## 配置选项

### 基本配置

```python
from ag_ui_claude import ClaudeAgent
from claude_agent_sdk import ClaudeAgentOptions

agent = ClaudeAgent(
    # 使用持久会话（推荐用于多轮对话）
    use_persistent_sessions=True,
    
    # 应用名称
    app_name="my_app",
    
    # 可选的 Claude SDK 配置
    claude_options=ClaudeAgentOptions(
        system_prompt="You are a helpful assistant",
        permission_mode='acceptEdits',
        max_tokens=4096,
        temperature=0.7
    ),
    
    # 执行超时（秒）
    execution_timeout_seconds=600,
    
    # 最大并发执行数
    max_concurrent_executions=10,
    
    # 会话超时（秒）
    session_timeout_seconds=1200,
    
    # 清理间隔（秒）
    cleanup_interval_seconds=300
)
```

### 无状态模式

对于简单的单次查询，可以使用无状态模式：

```python
agent = ClaudeAgent(
    use_persistent_sessions=False,  # 使用 query() 函数
    app_name="stateless_app"
)
```

详细配置选项请参考 [CONFIGURATION.md](./CONFIGURATION.md)。

## 直接使用 ClaudeAgent（不通过 FastAPI）

您也可以直接使用 `ClaudeAgent` 类，无需启动服务器：

```python
import asyncio
from ag_ui_claude import ClaudeAgent
from ag_ui.core import RunAgentInput, UserMessage
from claude_agent_sdk import ClaudeAgentOptions

async def main():
    # 创建 agent
    agent = ClaudeAgent(
        use_persistent_sessions=True,
        app_name="demo_app",
        user_id="demo_user",
        claude_options=ClaudeAgentOptions(
            system_prompt="You are a helpful assistant."
        )
    )
    
    # 创建输入
    input_data = RunAgentInput(
        thread_id="thread_001",
        run_id="run_001",
        messages=[
            UserMessage(id="1", role="user", content="Hello!")
        ],
        context=[],
        state={},
        tools=[],
        forwarded_props={}
    )
    
    # 运行并处理事件
    async for event in agent.run(input_data):
        print(f"Event: {event.type}")
        if hasattr(event, 'delta'):
            print(f"Content: {event.delta}")

if __name__ == "__main__":
    asyncio.run(main())
```

## 故障排除

### 1. API Key 错误

如果遇到认证错误：

```bash
# 确保设置了正确的环境变量
echo $ANTHROPIC_API_KEY  # 或
echo $ANTHROPIC_AUTH_TOKEN

# 如果未设置，请设置：
export ANTHROPIC_API_KEY=your-api-key-here
```

### 2. 端口被占用

如果 8000 端口被占用：

```bash
# 使用其他端口
uvicorn examples.server.fastapi_server:app --host 0.0.0.0 --port 8001
```

### 3. 导入错误

如果遇到导入错误：

```bash
# 确保已安装包
pip install -e .

# 检查 Python 版本
python --version  # 应该是 3.9+
```

### 4. 连接超时

如果遇到连接超时：

- 检查网络连接
- 确认 Anthropic API 端点可访问
- 检查防火墙设置
- 增加超时时间配置

## 下一步

- 📖 阅读 [ARCHITECTURE.md](./ARCHITECTURE.md) 了解架构设计
- ⚙️ 查看 [CONFIGURATION.md](./CONFIGURATION.md) 了解详细配置选项
- 🧪 运行测试套件验证功能
- 🔧 查看 [README.md](./README.md) 了解更多示例

## 参考资源

- [AG-UI Protocol 文档](https://ag-ui-protocol.github.io/ag-ui/)
- [Claude Agent SDK 文档](https://docs.claude.com/zh-CN/api/agent-sdk/python)
- [FastAPI 文档](https://fastapi.tiangolo.com/)

## 获取帮助

如果遇到问题：

1. 查看 [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) 了解实现状态
2. 检查测试用例了解正确用法
3. 查看 GitHub Issues 或创建新 Issue

