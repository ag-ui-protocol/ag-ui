# AG-UI Protocol Server Docker Setup

## Overview

The AG-UI Protocol includes a pre-built Docker image for the server starter example, providing a quick and easy way to run the server without manual Python environment setup.

## Docker Image

**Image:** `ag-ui-protocol/ag-ui-server:latest`

This image contains the fully configured AG-UI Protocol server with all features enabled, running on port 8000.

## Quick Start

### Starting the Server

```bash
docker run -d --name ag-ui-server -p 8000:8000 ag-ui-protocol/ag-ui-server:latest
```

This command:
- Runs the container in detached mode (`-d`)
- Names the container `ag-ui-server` for easy reference
- Maps port 8000 from the container to port 8000 on your host
- Uses the latest version of the server image

### Stopping the Server

```bash
docker stop ag-ui-server && docker rm ag-ui-server
```

### Checking Server Status

```bash
# View server logs
docker logs ag-ui-server

# Check if server is running
docker ps | grep ag-ui-server

# Test server health
curl http://localhost:8000/health
```

## Advanced Usage

### Running with Custom Environment Variables

```bash
docker run -d --name ag-ui-server \
  -p 8000:8000 \
  -e ENV_VAR_NAME=value \
  ag-ui-protocol/ag-ui-server:latest
```

### Running in Interactive Mode for Development

```bash
docker run -it --rm \
  --name ag-ui-server-dev \
  -p 8000:8000 \
  ag-ui-protocol/ag-ui-server:latest
```

### Using a Different Port

```bash
# Map to port 3000 on host instead of 8000
docker run -d --name ag-ui-server \
  -p 3000:8000 \
  ag-ui-protocol/ag-ui-server:latest
```

The server will be accessible at `http://localhost:3000`

## Integration Testing

For integration tests with the Dart SDK or other clients:

1. Start the server container before running tests
2. Ensure your test configuration points to `http://localhost:8000`
3. Stop and remove the container after tests complete

Example test script:
```bash
#!/bin/bash
# Start server
docker run -d --name ag-ui-test-server -p 8000:8000 ag-ui-protocol/ag-ui-server:latest

# Wait for server to be ready
sleep 5

# Run your tests
dart test

# Cleanup
docker stop ag-ui-test-server && docker rm ag-ui-test-server
```

## Troubleshooting

### Port Already in Use

If port 8000 is already in use, either:
1. Stop the conflicting service
2. Use a different port mapping (e.g., `-p 3000:8000`)

### Container Won't Start

Check Docker logs for errors:
```bash
docker logs ag-ui-server
```

### Image Not Found

Ensure the image is available locally:
```bash
docker images | grep ag-ui-protocol
```

## Benefits of Using Docker

- **No Python Setup Required**: No need to install Python, Poetry, or dependencies
- **Consistent Environment**: Same server version across all development machines
- **Quick Start/Stop**: Simple commands to manage the server lifecycle
- **Isolation**: Server runs in its own container without affecting your system
- **Easy Cleanup**: Remove container and all traces with a single command

## Related Documentation

- [Server Starter All Features](/typescript-sdk/integrations/server-starter-all-features/server/python/README.md)
- [AG-UI Protocol Documentation](/docs/protocol.md)