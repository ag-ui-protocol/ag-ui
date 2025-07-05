# 🔧 ADK Middleware Logging Configuration

The ADK middleware now supports granular logging control for different components. By default, most verbose logging is disabled for a cleaner experience.

## Quick Start

### 🔇 Default (Quiet Mode)
```bash
./quickstart.sh
# Only shows main agent info and errors
```

### 🔍 Debug Specific Components
```bash
# Debug streaming events
ADK_LOG_EVENT_TRANSLATOR=DEBUG ./quickstart.sh

# Debug HTTP responses  
ADK_LOG_ENDPOINT=DEBUG ./quickstart.sh

# Debug both streaming and HTTP
ADK_LOG_EVENT_TRANSLATOR=DEBUG ADK_LOG_ENDPOINT=DEBUG ./quickstart.sh
```

### 🐛 Debug Everything
```bash
ADK_LOG_EVENT_TRANSLATOR=DEBUG \
ADK_LOG_ENDPOINT=DEBUG \
ADK_LOG_RAW_RESPONSE=DEBUG \
ADK_LOG_LLM_RESPONSE=DEBUG \
./quickstart.sh
```

## Interactive Configuration

```bash
python configure_logging.py
```

This provides a menu-driven interface to:
- View current logging levels
- Set individual component levels
- Use quick configurations (streaming debug, quiet mode, etc.)
- Enable/disable specific components

## Available Components

| Component | Description | Default Level |
|-----------|-------------|---------------|
| `event_translator` | Event conversion logic | WARNING |
| `endpoint` | HTTP endpoint responses | WARNING |
| `raw_response` | Raw ADK responses | WARNING |
| `llm_response` | LLM response processing | WARNING |
| `adk_agent` | Main agent logic | INFO |
| `session_manager` | Session management | WARNING |
| `agent_registry` | Agent registration | WARNING |

## Environment Variables

Set these before running the server:

```bash
export ADK_LOG_EVENT_TRANSLATOR=DEBUG    # Show event translation details
export ADK_LOG_ENDPOINT=DEBUG           # Show HTTP response details
export ADK_LOG_RAW_RESPONSE=DEBUG       # Show raw ADK responses
export ADK_LOG_LLM_RESPONSE=DEBUG       # Show LLM processing
export ADK_LOG_ADK_AGENT=INFO           # Main agent info (default)
export ADK_LOG_SESSION_MANAGER=WARNING  # Session lifecycle (default)
export ADK_LOG_AGENT_REGISTRY=WARNING   # Agent registration (default)
```

## Python API

```python
from src.logging_config import configure_logging

# Enable specific debugging
configure_logging(
    event_translator='DEBUG',
    endpoint='DEBUG'
)

# Quiet mode
configure_logging(
    event_translator='ERROR',
    endpoint='ERROR',
    raw_response='ERROR'
)
```

## Common Use Cases

### 🔍 Debugging Streaming Issues
```bash
ADK_LOG_EVENT_TRANSLATOR=DEBUG ./quickstart.sh
```
Shows: partial events, turn_complete, is_final_response, TEXT_MESSAGE_* events

### 🌐 Debugging Client Connection Issues  
```bash
ADK_LOG_ENDPOINT=DEBUG ./quickstart.sh
```
Shows: HTTP responses, SSE data being sent to clients

### 📡 Debugging ADK Integration
```bash
ADK_LOG_RAW_RESPONSE=DEBUG ./quickstart.sh
```
Shows: Raw responses from Google ADK API

### 🔇 Production Mode
```bash
# Default behavior - only errors and main agent info
./quickstart.sh
```

## Log Levels

- **DEBUG**: Verbose details for development
- **INFO**: Important operational information  
- **WARNING**: Warnings and recoverable issues (default for most components)
- **ERROR**: Only errors and critical issues