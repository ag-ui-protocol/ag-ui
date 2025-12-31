#!/usr/bin/env python3
"""Simple test script for Claude Agent SDK integration."""

import asyncio
import aiohttp
import json
import sys
import os

# Check environment variables
if not os.getenv("ANTHROPIC_API_KEY") and not os.getenv("ANTHROPIC_AUTH_TOKEN"):
    print("❌ Error: Please set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN environment variable")
    print("\nExample:")
    print("  export ANTHROPIC_API_KEY=your-api-key-here")
    sys.exit(1)

SERVER_URL = os.getenv("AG_UI_SERVER_URL", "http://localhost:8000/chat")


async def test_basic_conversation():
    """Test basic conversation functionality"""
    print(f"📡 Connecting to server: {SERVER_URL}")
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
                    print(f"❌ Error: HTTP {response.status}")
                    text = await response.text()
                    print(f"Response: {text}")
                    return
                
                print("✅ Connection successful! Waiting for response...\n")
                print("🤖 Assistant: ", end="", flush=True)
                
                # Read SSE stream
                buffer = ""
                async for chunk in response.content.iter_chunked(1024):
                    if chunk:
                        buffer += chunk.decode('utf-8')
                        lines = buffer.split('\n')
                        buffer = lines[-1]  # Keep incomplete line
                        
                        for line in lines[:-1]:
                            line = line.strip()
                            if line.startswith('data: '):
                                data = line[6:]  # Remove 'data: ' prefix
                                try:
                                    event = json.loads(data)
                                    event_type = event.get('type', 'unknown')
                                    
                                    # Handle text content
                                    if 'delta' in event:
                                        print(event['delta'], end="", flush=True)
                                    elif event_type == 'TEXT_MESSAGE_END':
                                        print("\n")
                                    elif event_type == 'RUN_FINISHED':
                                        print("\n✅ Conversation completed!")
                                    elif event_type == 'RUN_ERROR':
                                        print(f"\n❌ Error: {event.get('error', 'Unknown error')}")
                                        
                                except json.JSONDecodeError:
                                    pass
                
                print("\n" + "=" * 60)
                
    except aiohttp.ClientConnectorError:
        print(f"❌ Error: Cannot connect to server {SERVER_URL}")
        print("\nPlease ensure:")
        print("  1. Server is running (python examples/server/fastapi_server.py)")
        print("  2. Server address is correct")
        print("  3. Firewall allows connection")
    except Exception as e:
        print(f"❌ Error: {type(e).__name__}: {e}")


async def test_interactive_mode():
    """Interactive test mode"""
    print(f"📡 Connecting to server: {SERVER_URL}")
    print("=" * 60)
    print("💡 Tip: Enter a message and press Enter, type 'quit' to exit")
    print("=" * 60)
    
    thread_id = f"interactive-{os.getpid()}"
    run_counter = 0
    
    try:
        while True:
            user_input = input("\n👤 You: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() in ['quit', 'exit', 'q']:
                print("\n👋 Goodbye!")
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
                        print(f"❌ Error: HTTP {response.status}")
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
                                            print(f"\n❌ Error: {event.get('error', 'Unknown error')}")
                                            break
                                    except json.JSONDecodeError:
                                        pass
                    
                    print()  # New line
                    
    except KeyboardInterrupt:
        print("\n\n👋 Goodbye!")
    except Exception as e:
        print(f"\n❌ Error: {type(e).__name__}: {e}")


def main():
    """Main function"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description="Test Claude Agent SDK integration",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Basic test
  python test_client.py

  # Interactive mode
  python test_client.py --interactive

  # Custom server address
  python test_client.py --server http://localhost:8001/chat
        """
    )
    
    parser.add_argument(
        '-i', '--interactive',
        action='store_true',
        help='Enable interactive mode'
    )
    
    parser.add_argument(
        '-s', '--server',
        default=SERVER_URL,
        help=f'Server address (default: {SERVER_URL})'
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
