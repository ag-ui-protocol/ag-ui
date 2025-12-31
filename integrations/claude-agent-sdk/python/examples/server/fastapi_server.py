"""Example FastAPI server for Claude Agent SDK integration."""

import os
from pathlib import Path
from fastapi import FastAPI
from ag_ui_claude import ClaudeAgent, add_claude_fastapi_endpoint

# Load environment variables from .env.local if it exists
try:
    from dotenv import load_dotenv
    env_path = Path(__file__).parent.parent.parent / ".env.local"
    if env_path.exists():
        load_dotenv(env_path)
        print(f"✅ Loaded environment variables from {env_path}")
except ImportError:
    # python-dotenv not installed, skip
    pass

# Claude Agent SDK will use ANTHROPIC_API_KEY from environment if not provided
# No need to explicitly pass api_key unless you want to override

# IMPORTANT: Claude Agent SDK requires @anthropic-ai/claude-code CLI tool to be installed.
# Install it with: npm install -g @anthropic-ai/claude-code
# Or set the path via ClaudeAgentOptions(cli_path='/path/to/claude')

# Try to find claude CLI path automatically
import shutil
import os

# Try multiple ways to find claude CLI
claude_path = shutil.which('claude')
if not claude_path or not os.path.exists(claude_path):
    # Try common locations
    home_dir = os.path.expanduser('~')
    possible_paths = [
        os.path.join(home_dir, '.claude', 'local', 'claude'),
        os.path.join(home_dir, 'node_modules', '.bin', 'claude'),
        '/usr/local/bin/claude',
        '/opt/homebrew/bin/claude',  # macOS Homebrew
    ]
    for path in possible_paths:
        if os.path.exists(path):
            claude_path = path
            break

# Log detected CLI path for debugging
if claude_path and os.path.exists(claude_path):
    print(f"✅ Detected Claude CLI at: {claude_path}")
else:
    print("⚠️  Claude CLI not found. Please install with: npm install -g @anthropic-ai/claude-code")

from claude_agent_sdk import ClaudeAgentOptions

# Example 1: Using persistent sessions (ClaudeSDKClient) - RECOMMENDED
# Supports multi-turn conversations, interrupts, hooks, custom tools, etc.
# See: https://docs.claude.com/api/agent-sdk/python#choosing-between-query-and-claudesdkclient
agent = ClaudeAgent(
    use_persistent_sessions=True,  # Use ClaudeSDKClient for full features
    app_name="example_app",
    claude_options=ClaudeAgentOptions(
        system_prompt="You are a helpful assistant",
        permission_mode='acceptEdits',
        cli_path=claude_path if claude_path and os.path.exists(claude_path) else None  # Auto-detect CLI path
    )
)

# Example 2: Using stateless mode (query()) - limited features
# Only supports single-turn conversations, no hooks, interrupts, or custom tools
# agent = ClaudeAgent(
#     use_persistent_sessions=False,
#     app_name="example_app",
#     claude_options=ClaudeAgentOptions(
#         system_prompt="You are a helpful assistant",
#         cli_path=claude_path if claude_path and os.path.exists(claude_path) else None
#     )
# )

# Create FastAPI app
app = FastAPI(title="Claude Agent SDK Example")

# Add CORS middleware for CopilotKit integration
from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],  # Add your frontend URLs
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Add AG-UI endpoint
add_claude_fastapi_endpoint(app, agent, path="/chat")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

