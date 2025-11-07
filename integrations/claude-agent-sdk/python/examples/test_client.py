#!/usr/bin/env python3
"""Simple test script for Claude Agent SDK integration."""

import asyncio
import aiohttp
import json
import sys
import os

# 检查环境变量
if not os.getenv("ANTHROPIC_API_KEY") and not os.getenv("ANTHROPIC_AUTH_TOKEN"):
    print("❌ 错误: 请设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN 环境变量")
    print("\n示例:")
    print("  export ANTHROPIC_API_KEY=your-api-key-here")
    sys.exit(1)

SERVER_URL = os.getenv("AG_UI_SERVER_URL", "http://localhost:8000/chat")


async def test_basic_conversation():
    """测试基本对话功能"""
    print(f"📡 连接到服务器: {SERVER_URL}")
    print("=" * 60)
    
    url = SERVER_URL
    
    payload = {
        "threadId": "test-thread-1",
        "runId": "test-run-1",
        "messages": [
            {
                "id": "msg-1",
                "role": "user",
                "content": "Hello! Can you introduce yourself in one sentence?"
            }
        ],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {}
    }
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status != 200:
                    print(f"❌ 错误: HTTP {response.status}")
                    text = await response.text()
                    print(f"响应: {text}")
                    return
                
                print("✅ 连接成功! 等待响应...\n")
                print("🤖 Assistant: ", end="", flush=True)
                
                # 读取 SSE 流
                buffer = ""
                async for chunk in response.content.iter_chunked(1024):
                    if chunk:
                        buffer += chunk.decode('utf-8')
                        lines = buffer.split('\n')
                        buffer = lines[-1]  # 保留不完整的行
                        
                        for line in lines[:-1]:
                            line = line.strip()
                            if line.startswith('data: '):
                                data = line[6:]  # 移除 'data: ' 前缀
                                try:
                                    event = json.loads(data)
                                    event_type = event.get('type', 'unknown')
                                    
                                    # 处理文本内容
                                    if 'delta' in event:
                                        print(event['delta'], end="", flush=True)
                                    elif event_type == 'TEXT_MESSAGE_END':
                                        print("\n")
                                    elif event_type == 'RUN_FINISHED':
                                        print("\n✅ 对话完成!")
                                    elif event_type == 'RUN_ERROR':
                                        print(f"\n❌ 错误: {event.get('error', 'Unknown error')}")
                                        
                                except json.JSONDecodeError:
                                    pass
                
                print("\n" + "=" * 60)
                
    except aiohttp.ClientConnectorError:
        print(f"❌ 错误: 无法连接到服务器 {SERVER_URL}")
        print("\n请确保:")
        print("  1. 服务器正在运行 (python examples/server/fastapi_server.py)")
        print("  2. 服务器地址正确")
        print("  3. 防火墙允许连接")
    except Exception as e:
        print(f"❌ 错误: {type(e).__name__}: {e}")


async def test_interactive_mode():
    """交互式测试模式"""
    print(f"📡 连接到服务器: {SERVER_URL}")
    print("=" * 60)
    print("💡 提示: 输入消息并按 Enter，输入 'quit' 退出")
    print("=" * 60)
    
    thread_id = f"interactive-{os.getpid()}"
    run_counter = 0
    
    try:
        while True:
            user_input = input("\n👤 You: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("\n👋 再见!")
                break
            
            run_counter += 1
            url = SERVER_URL
            
            payload = {
                "threadId": thread_id,
                "runId": f"run-{run_counter}",
                "messages": [
                    {
                        "id": f"msg-{run_counter}",
                        "role": "user",
                        "content": user_input
                    }
                ],
                "tools": [],
                "context": [],
                "state": {},
                "forwardedProps": {}
            }
            
            async with aiohttp.ClientSession() as session:
                async with session.post(url, json=payload) as response:
                    if response.status != 200:
                        print(f"❌ 错误: HTTP {response.status}")
                        continue
                    
                    print("🤖 Assistant: ", end="", flush=True)
                    
                    buffer = ""
                    async for chunk in response.content.iter_chunked(1024):
                        if chunk:
                            buffer += chunk.decode('utf-8')
                            lines = buffer.split('\n')
                            buffer = lines[-1]
                            
                            for line in lines[:-1]:
                                line = line.strip()
                                if line.startswith('data: '):
                                    data = line[6:]
                                    try:
                                        event = json.loads(data)
                                        if 'delta' in event:
                                            print(event['delta'], end="", flush=True)
                                        elif event.get('type') == 'RUN_ERROR':
                                            print(f"\n❌ 错误: {event.get('error', 'Unknown error')}")
                                            break
                                    except json.JSONDecodeError:
                                        pass
                    
                    print()  # 换行
                    
    except KeyboardInterrupt:
        print("\n\n👋 再见!")
    except Exception as e:
        print(f"\n❌ 错误: {type(e).__name__}: {e}")


def main():
    """主函数"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="测试 Claude Agent SDK 集成",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
  # 基本测试
  python test_client.py

  # 交互式模式
  python test_client.py --interactive

  # 自定义服务器地址
  python test_client.py --server http://localhost:8001/chat
        """
    )
    
    parser.add_argument(
        '-i', '--interactive',
        action='store_true',
        help='启用交互式模式'
    )
    
    parser.add_argument(
        '-s', '--server',
        default=SERVER_URL,
        help=f'服务器地址 (默认: {SERVER_URL})'
    )
    
    args = parser.parse_args()
    
    global SERVER_URL
    SERVER_URL = args.server
    
    if args.interactive:
        asyncio.run(test_interactive_mode())
    else:
        asyncio.run(test_basic_conversation())


if __name__ == "__main__":
    main()

