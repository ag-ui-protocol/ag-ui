# Basic Examples

This directory contains basic examples demonstrating how to use the AG-UI Go SDK.

## Examples

### Simple Agent
- **File**: `simple_agent.go`
- **Description**: A minimal agent that responds to text messages
- **Concepts**: Agent interface, event handling, basic responses

### Echo Server
- **File**: `echo_server.go`
- **Description**: A server that echoes back received messages
- **Concepts**: Server setup, agent registration, HTTP transport

### Basic Client
- **File**: `basic_client.go`
- **Description**: A client that connects to an AG-UI server and sends messages
- **Concepts**: Client configuration, event sending, response handling

## Running the Examples

```bash
# Run a basic agent server
go run examples/basic/echo_server.go

# Run a basic client
go run examples/basic/basic_client.go
```

## Prerequisites

- Go 1.21 or later
- Basic understanding of the AG-UI protocol

## Next Steps

After exploring these basic examples, check out the [advanced examples](../advanced/) for more complex use cases. 