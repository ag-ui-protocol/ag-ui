"""
Configuration constants for Claude Agent SDK adapter.

Defines whitelists, defaults, and configuration options.
"""

# Whitelist of forwarded_props keys that can be applied as per-run option overrides
# These are runtime execution controls, not agent identity/security settings
ALLOWED_FORWARDED_PROPS = {
    # Session control
    "resume",                    # Session ID to resume
    "fork_session",             # Fork vs continue session
    "resume_session_at",        # Time travel to specific message
    
    # Model control  
    "model",                    # Per-run model override
    "fallback_model",           # Fallback if primary fails
    "temperature",              # Sampling temperature
    "max_tokens",               # Response length limit
    "max_thinking_tokens",      # Reasoning depth limit
    "max_turns",                # Conversation turn limit
    "max_budget_usd",          # Cost limit per run
    
    # Output control
    "output_format",            # Structured output schema
    "include_partial_messages", # Streaming granularity
    
    # Optional features
    "enable_file_checkpointing", # File change tracking
    "strict_mcp_config",         # MCP validation strictness
    "betas",                     # Beta feature flags
}

# Special tool name for state management
STATE_MANAGEMENT_TOOL_NAME = "ag_ui_update_state"
# Full prefixed name as it appears from Claude SDK
STATE_MANAGEMENT_TOOL_FULL_NAME = "mcp__ag_ui__ag_ui_update_state"

# MCP server name for dynamic AG-UI tools
AG_UI_MCP_SERVER_NAME = "ag_ui"
