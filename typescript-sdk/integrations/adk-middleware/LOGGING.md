# 🔧 ADK Middleware Logging Configuration

The ADK middleware uses standard Python logging. By default, most verbose logging is disabled for a cleaner experience.

## Quick Start

### 🔇 Default (Quiet Mode)
```bash
./quickstart.sh
# Only shows main agent info and errors
```

### 🔍 Debug Specific Components

Add this to your script or setup code:

```python
import logging

# Debug session management
logging.getLogger('session_manager').setLevel(logging.DEBUG)

# Debug event translation
logging.getLogger('event_translator').setLevel(logging.DEBUG)

# Debug HTTP endpoint responses
logging.getLogger('endpoint').setLevel(logging.DEBUG)

# Debug main agent logic
logging.getLogger('adk_agent').setLevel(logging.DEBUG)
```

### 🐛 Debug Everything
```python
import logging

# Set root logger to DEBUG
logging.getLogger().setLevel(logging.DEBUG)

# Or configure specific components
components = ['adk_agent', 'event_translator', 'endpoint', 'session_manager']
for component in components:
    logging.getLogger(component).setLevel(logging.DEBUG)
```

## Available Components

| Component | Description | Default Level |
|-----------|-------------|---------------|
| `event_translator` | Event conversion logic | WARNING |
| `endpoint` | HTTP endpoint responses | WARNING |
| `adk_agent` | Main agent logic | INFO |
| `session_manager` | Session management | WARNING |

## Python API

### Setting Individual Component Levels
```python
import logging

# Enable specific debugging
logging.getLogger('event_translator').setLevel(logging.DEBUG)
logging.getLogger('endpoint').setLevel(logging.DEBUG)

# Quiet mode
logging.getLogger('event_translator').setLevel(logging.ERROR)
logging.getLogger('endpoint').setLevel(logging.ERROR)
```

### Global Configuration
```python
import logging

# Configure basic logging format
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

# Set component-specific levels
logging.getLogger('session_manager').setLevel(logging.DEBUG)
```

## Common Use Cases

### 🔍 Debugging Streaming Issues
```python
logging.getLogger('event_translator').setLevel(logging.DEBUG)
```
Shows: partial events, turn_complete, is_final_response, TEXT_MESSAGE_* events

### 🌐 Debugging Client Connection Issues  
```python
logging.getLogger('endpoint').setLevel(logging.DEBUG)
```
Shows: HTTP responses, SSE data being sent to clients

### 📊 Debugging Session Management
```python
logging.getLogger('session_manager').setLevel(logging.DEBUG)
```
Shows: Session creation, deletion, cleanup, memory operations

### 🔇 Production Mode
```python
# Default behavior - only errors and main agent info
# No additional configuration needed
```

## Log Levels

- **DEBUG**: Verbose details for development
- **INFO**: Important operational information  
- **WARNING**: Warnings and recoverable issues (default for most components)
- **ERROR**: Only errors and critical issues

## Environment-Based Configuration

You can also set logging levels via environment variables by modifying your startup script:

```python
import os
import logging

# Check environment variables for log levels
components = {
    'adk_agent': os.getenv('LOG_ADK_AGENT', 'INFO'),
    'event_translator': os.getenv('LOG_EVENT_TRANSLATOR', 'WARNING'),
    'endpoint': os.getenv('LOG_ENDPOINT', 'WARNING'),
    'session_manager': os.getenv('LOG_SESSION_MANAGER', 'WARNING')
}

for component, level in components.items():
    logging.getLogger(component).setLevel(getattr(logging, level.upper()))
```

Then use:
```bash
LOG_SESSION_MANAGER=DEBUG ./quickstart.sh
```