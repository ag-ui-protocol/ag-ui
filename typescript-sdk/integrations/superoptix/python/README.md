# AG-UI SuperOptiX Python Server

This package provides the Python server implementation for AG-UI integration with SuperOptiX agents.

## Features

- FastAPI server for SuperOptiX DSPy pipelines
- AG-UI event streaming
- Tool call handling
- State management

## Installation

```bash
poetry install
```

## Development

```bash
poetry run dev
```

## Usage

```python
from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint
from fastapi import FastAPI

app = FastAPI()
add_superoptix_fastapi_endpoint(app, agent_name="developer", path="/")
``` 