# ADK Middleware 实现逻辑详解

## 目录

1. [架构概述](#架构概述)
2. [核心组件](#核心组件)
3. [执行流程](#执行流程)
4. [事件转换机制](#事件转换机制)
5. [会话管理](#会话管理)
6. [工具支持](#工具支持)
7. [状态管理](#状态管理)
8. [错误处理](#错误处理)

---

## 架构概述

ADK Middleware 是一个协议适配层，将 Google ADK (Agent Development Kit) 的执行模型转换为 AG-UI Protocol 的事件流。整体架构采用事件驱动、异步执行的设计模式。

### 设计原则

1. **协议桥接**: 将 ADK 的事件模型转换为 AG-UI 的标准事件类型
2. **异步执行**: 使用后台任务执行 ADK agent，通过队列流式传输事件
3. **会话隔离**: 每个 thread_id 对应一个 ADK session，保持对话连续性
4. **工具代理**: 客户端工具通过代理模式转发到前端执行

### 数据流

```
AG-UI Client
    ↓ (RunAgentInput)
ADKAgent.run()
    ↓ (后台执行)
ADK Runner
    ↓ (ADK Events)
EventTranslator
    ↓ (AG-UI Events)
Event Queue
    ↓ (流式传输)
AG-UI Client
```

---

## 核心组件

### 1. ADKAgent

**位置**: `src/ag_ui_adk/adk_agent.py`

ADKAgent 是整个中间件的核心入口，负责：

- **初始化配置**: 管理 ADK agent、服务、会话参数
- **执行编排**: 协调新执行启动、工具结果处理、消息批处理
- **生命周期管理**: 管理 RUN_STARTED/FINISHED 事件、错误处理

#### 关键方法

```python
async def run(input: RunAgentInput) -> AsyncGenerator[BaseEvent, None]
```
主入口方法，处理消息分类和执行路由：

1. **消息分析**: 识别未处理消息 (`_get_unseen_messages`)
2. **路由决策**:
   - 工具结果消息 → `_handle_tool_result_submission`
   - 新用户消息 → `_start_new_execution`
   - Assistant 消息 → 标记为已处理
3. **事件流式输出**: 异步生成 AG-UI 协议事件

#### 初始化参数

- `adk_agent`: Google ADK Agent 实例
- `app_name` / `user_id`: 应用和用户标识（支持静态或动态提取）
- `session_service`: ADK 会话服务（默认 InMemorySessionService）
- `memory_service`: 记忆服务（可选，用于会话记忆）
- `run_config_factory`: 自定义 RunConfig 工厂函数
- `execution_timeout_seconds`: 执行超时（默认 600 秒）
- `tool_timeout_seconds`: 工具调用超时（默认 300 秒）

### 2. EventTranslator

**位置**: `src/ag_ui_adk/event_translator.py`

EventTranslator 负责将 ADK 事件转换为 AG-UI 协议事件。

#### 转换映射

| ADK Event | AG-UI Event |
|-----------|-------------|
| Content with text (partial) | TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT |
| Content with text (final) | TEXT_MESSAGE_END |
| FunctionCall | TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END |
| FunctionResponse | TOOL_CALL_RESULT |
| LongRunningFunctionCall | TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END (LRO) |
| Actions.state_delta | STATE_DELTA |

#### 流式文本处理

EventTranslator 维护流式消息状态：

- `_streaming_message_id`: 当前流式消息 ID
- `_is_streaming`: 是否正在流式传输
- `_current_stream_text`: 累积的文本内容
- `_last_streamed_text`: 上次流式传输的文本（用于去重）

**去重机制**: 当检测到 `is_final_response` 事件时，如果内容与刚完成的流式传输相同，则跳过以避免重复。

#### 长运行工具 (LRO) 处理

```python
async def translate_lro_function_calls(adk_event: ADKEvent)
```

专门处理长运行工具调用：
- 从 `adk_event.long_running_tool_ids` 识别 LRO 工具
- 立即发送 TOOL_CALL_START/ARGS/END 事件
- 标记为 LRO，前端负责执行

### 3. SessionManager

**位置**: `src/ag_ui_adk/session_manager.py`

SessionManager 是单例模式，封装 ADK 的会话服务，添加生产级功能。

#### 核心功能

1. **会话生命周期**:
   - `get_or_create_session()`: 获取或创建会话
   - 会话键格式: `{app_name}:{session_id}`
   - 用户会话跟踪: `_user_sessions[user_id] -> Set[session_keys]`

2. **超时管理**:
   - 基于 `session.last_update_time` 检测过期
   - 后台清理任务（默认 5 分钟间隔）
   - 保留有 pending tool calls 的会话（HITL 场景）

3. **状态管理**:
   - `update_session_state()`: 更新会话状态（使用 ADK EventActions）
   - `get_state_value()` / `set_state_value()`: 键值对操作
   - `clear_session_state()`: 清理状态（支持前缀保留）

4. **消息追踪**:
   - `get_processed_message_ids()`: 获取已处理消息 ID
   - `mark_messages_processed()`: 标记消息为已处理
   - 用于避免重复处理消息

5. **自动记忆**:
   - 如果配置了 `memory_service`，删除会话前自动添加到记忆

### 4. ClientProxyToolset / ClientProxyTool

**位置**: `src/ag_ui_adk/client_proxy_toolset.py`, `client_proxy_tool.py`

实现客户端工具的代理模式。

#### ClientProxyToolset

- 动态创建: 每个执行根据 `RunAgentInput.tools` 创建
- 工具包装: 将 AG-UI Tool 包装为 `ClientProxyTool`
- 事件队列注入: 每个工具共享同一个事件队列

#### ClientProxyTool

继承 `BaseTool`，内部使用 `LongRunningFunctionTool`：

1. **参数声明**: `_get_declaration()` 将 AG-UI JSON Schema 转换为 ADK `FunctionDeclaration`
2. **执行流程**:
   ```python
   async def _execute_proxy_tool(args, tool_context):
       # 1. 发送 TOOL_CALL_START
       # 2. 发送 TOOL_CALL_ARGS
       # 3. 发送 TOOL_CALL_END
       # 4. 返回 None (LRO 工具)
   ```
3. **ID 管理**: 优先使用 ADK 生成的 `function_call_id`，否则生成 UUID

### 5. ExecutionState

**位置**: `src/ag_ui_adk/execution_state.py`

跟踪后台执行的元数据：

- `task`: asyncio.Task 对象
- `thread_id`: 线程标识
- `event_queue`: 事件队列
- `pending_tool_calls`: 待处理的工具调用 ID（HITL 场景）
- `is_complete`: 执行是否完成

---

## 执行流程

### 1. 新执行启动流程

```
用户请求 (RunAgentInput)
    ↓
ADKAgent.run()
    ↓
分析未处理消息
    ↓
_start_new_execution()
    ↓
发送 RUN_STARTED 事件
    ↓
_start_background_execution()
    ↓
创建 Event Queue
准备 Agent (SystemMessage + Tools)
创建 Runner
    ↓
后台任务: _run_adk_in_background()
    ↓
确保会话存在
更新会话状态 (同步前端状态)
转换消息为 ADK 格式
    ↓
runner.run_async()
    ↓
ADK Events → EventTranslator → AG-UI Events → Queue
    ↓
_stream_events() 从队列读取并流式输出
    ↓
发送 RUN_FINISHED 事件
```

### 2. 工具结果提交流程

```
前端工具执行完成
    ↓
发送 ToolMessage (role="tool")
    ↓
ADKAgent.run()
    ↓
识别为工具结果消息
    ↓
_handle_tool_result_submission()
    ↓
_extract_tool_results()
    ↓
转换为 ADK FunctionResponse
    ↓
_start_new_execution(tool_results=...)
    ↓
_run_adk_in_background()
    ↓
创建 Content(role='function', parts=[FunctionResponse])
    ↓
runner.run_async(new_message=function_response)
    ↓
ADK 继续处理工具结果
```

### 3. 消息批处理

`run()` 方法将未处理消息分组处理：

- **工具消息批**: 连续的工具消息批量提交
- **普通消息批**: 非工具消息批量提交
- **Assistant 消息**: 标记为已处理，不触发执行

---

## 事件转换机制

### ADK 事件属性

ADK 事件的关键属性：

- `partial`: 是否为部分响应（流式）
- `turn_complete`: 回合是否完成
- `is_final_response()`: 是否为最终响应
- `finish_reason`: 完成原因
- `long_running_tool_ids`: 长运行工具 ID 列表

### 文本消息转换

```python
async def _translate_text_content(adk_event, thread_id, run_id):
    # 1. 检查 is_final_response
    if is_final_response:
        if _is_streaming:
            # 关闭活跃流
            yield TEXT_MESSAGE_END
        else:
            # 检查去重
            if not is_duplicate:
                yield TEXT_MESSAGE_START
                yield TEXT_MESSAGE_CONTENT
                yield TEXT_MESSAGE_END
        return
    
    # 2. 流式处理
    if not _is_streaming:
        yield TEXT_MESSAGE_START
        _is_streaming = True
    
    yield TEXT_MESSAGE_CONTENT
    
    if should_send_end:
        yield TEXT_MESSAGE_END
        _is_streaming = False
```

### 工具调用转换

**普通工具**:
```
FunctionCall → TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END
FunctionResponse → TOOL_CALL_RESULT
```

**长运行工具**:
```
LongRunningFunctionCall → TOOL_CALL_START → TOOL_CALL_ARGS → TOOL_CALL_END
(不发送 TOOL_CALL_RESULT，由前端执行)
```

### 状态转换

```python
def _create_state_delta_event(state_delta, thread_id, run_id):
    # 转换为 JSON Patch (RFC 6902)
    patches = [
        {"op": "add", "path": f"/{key}", "value": value}
        for key, value in state_delta.items()
    ]
    return StateDeltaEvent(delta=patches)
```

---

## 会话管理

### 会话键结构

```
session_key = f"{app_name}:{session_id}"
```

### 会话查找缓存

`ADKAgent._session_lookup_cache` 提供 O(1) 查找：

```python
_cache[session_id] = {"app_name": str, "user_id": str}
```

### 自动清理机制

```python
async def _cleanup_expired_sessions():
    for session_key in tracked_sessions:
        session = await get_session(...)
        age = current_time - session.last_update_time
        if age > timeout:
            pending_calls = session.state.get("pending_tool_calls", [])
            if not pending_calls:
                await _delete_session(session)
```

**保护机制**: 有 pending tool calls 的会话不会被清理（HITL 场景）。

### 用户会话限制

如果设置了 `max_sessions_per_user`：

```python
if user_count >= max_sessions_per_user:
    await _remove_oldest_user_session(user_id)
```

基于 `last_update_time` 删除最旧的会话。

---

## 工具支持

### 工具类型

1. **后端工具**: ADK Agent 直接提供的工具（同步执行）
2. **前端工具**: 通过 `ClientProxyTool` 代理的工具（长运行）

### 工具合并策略

```python
# 1. 获取 Agent 现有工具
existing_tools = adk_agent.tools

# 2. 过滤前端工具（避免与后端工具冲突）
input_tools = [
    tool for tool in input.tools
    if tool.name not in existing_tool_names
    and tool.name != 'transfer_to_agent'  # ADK 内部工具
]

# 3. 创建代理工具集
proxy_toolset = ClientProxyToolset(input_tools, event_queue)

# 4. 合并
combined_tools = existing_tools + [proxy_toolset]
```

### 工具执行流程

**前端工具**:
```
ADK Agent 调用工具
    ↓
ClientProxyTool.run_async()
    ↓
发送 TOOL_CALL_START/ARGS/END 事件
    ↓
返回 None (LRO)
    ↓
前端接收事件并执行
    ↓
前端发送 ToolMessage
    ↓
继续执行
```

**后端工具**:
```
ADK Agent 调用工具
    ↓
执行工具函数
    ↓
返回结果
    ↓
ADK 生成 FunctionResponse
    ↓
EventTranslator 转换为 TOOL_CALL_RESULT
```

### 工具结果处理

```python
# 解析 JSON 内容
try:
    result = json.loads(content)
except json.JSONDecodeError:
    result = {
        "error": f"Invalid JSON: {str(error)}",
        "error_type": "JSON_DECODE_ERROR"
    }

# 创建 FunctionResponse
function_response = types.FunctionResponse(
    id=tool_call_id,
    name=tool_name,
    response=result
)
```

---

## 状态管理

### 状态同步方向

1. **前端 → 后端**: 每次执行前更新会话状态
   ```python
   await session_manager.update_session_state(
       thread_id, app_name, user_id, input.state
   )
   ```

2. **后端 → 前端**: 通过 STATE_DELTA 事件
   ```python
   if adk_event.actions.state_delta:
       yield StateDeltaEvent(delta=json_patch)
   ```

3. **最终快照**: 执行完成后发送 STATE_SNAPSHOT
   ```python
   final_state = await session_manager.get_session_state(...)
   yield StateSnapshotEvent(snapshot=final_state)
   ```

### National JSON Patch 格式

状态变更使用 JSON Patch (RFC 6902):

```json
[
  {"op": "add", "path": "/key", "value": "value"},
  {"op": "remove", "path": "/old_key"}
]
```

### 状态更新实现

```python
# 使用 ADK EventActions
actions = EventActions(state_delta=updates)
event = Event(
    invocation_id=f"state_update_{timestamp}",
    author="system",
    actions=actions
)
await session_service.append_event(session, event)
```

---

## 错误处理

### 错误类型

1. **执行超时**: `execution.is_stale(timeout)` → `RUN_ERROR` (code: "EXECUTION_TIMEOUT")
2. **工具结果错误**: JSON 解析失败 → 包含错误信息的 FunctionResponse
3. **编码错误**: EventEncoder 失败 → `RUN_ERROR` (code: "ENCODING_ERROR")
4. **后台执行错误**: 异常捕获 → `RUN_ERROR` (code: "BACKGROUND_EXECUTION_ERROR")

### 错误传播

```python
try:
    async for event in agent.run(input):
        yield event
except Exception as e:
    yield RunErrorEvent(
        type=EventType.RUN_ERROR,
        message=str(e),
        code="AGENT_ERROR"
    )
```

### 清理机制

执行完成后清理：

```python
finally:
    if execution.is_complete:
        has_pending = await _has_pending_tool_calls(thread_id)
        if not has_pending:
            del _active_executions[thread_id]
```

**HITL 保护**: 有 pending tool calls 的执行不会被清理。

---

## 关键设计决策

### 1. 所有客户端工具都是长运行工具

**原因**: 简化架构，统一处理流程，避免同步等待。

### 2. 后台执行 + 事件队列

**原因**: 
- ADK 的执行是阻塞的，需要后台运行
- 流式输出需要队列缓冲
- 支持并发执行多个请求

### 3. 会话状态同步

**原因**: 
- 前端可能修改状态（如 UI 操作）
- 后端需要最新状态进行推理
- 双向同步保证一致性

### 4. 消息去重

**原因**: 
- ADK 可能同时发送流式块和最终响应
- 避免前端重复渲染
- 基于 run_id 和内容匹配

### 5. 单例 SessionManager

**原因**: 
- 全局会话管理
- 统一的清理任务
- 跨 Agent 实例共享状态

---

## 性能考虑

### 并发限制

```python
max_concurrent_executions = 10  # 默认
```

超过限制时清理过期执行，仍满则抛出异常。

### 会话查找优化

- O(1) 缓存查找 (`_session_lookup_cache`)
- 回退到线性搜索（向后兼容）

### 事件队列大小

使用 `asyncio.Queue`，无大小限制，依赖 backpressure 机制。

---

## 扩展点

### 自定义 RunConfig

```python
def custom_run_config(input: RunAgentInput) -> ADKRunConfig:
    return ADKRunConfig(
        streaming_mode=StreamingMode.SSE,
        save_input_blobs_as_artifacts=True,
        # 自定义配置
    )

agent = ADKAgent(
    adk_agent=my_agent,
    run_config_factory=custom_run_config
)
```

### 自定义 App/User 提取

```python
def extract_app_name(input: RunAgentInput) -> str:
    return input.context.get("app_name", "default")

agent = ADKAgent(
    adk_agent=my_agent,
    app_name_extractor=extract_app_name
)
```

### 自定义服务

```python
from google.adk.sessions import MyCustomSessionService

agent = ADKAgent(
    adk_agent=my_agent,
    session_service=MyCustomSessionService(),
    use_in_memory_services=False
)
```

---

## 总结

ADK Middleware 通过精心设计的事件转换、会话管理和工具代理机制，实现了 Google ADK 与 AG-UI Protocol 之间的无缝桥接。核心设计围绕异步执行、事件驱动和状态同步展开，确保高并发、低延迟的智能体交互体验。

