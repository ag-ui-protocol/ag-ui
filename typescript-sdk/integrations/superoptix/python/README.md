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

## Prerequisites

Your SuperOptiX project must follow the standard SuperOptiX project structure:

```
your_project/
├── .super                    # Project configuration file
├── your_project_name/        # Project name directory
│   └── agents/
│       └── your_agent_name/  # Agent directory
│           ├── pipelines/
│           │   └── your_agent_name_pipeline.py  # Pipeline file
│           └── playbook/
│               └── your_agent_name_playbook.yaml  # Playbook file
```

## Usage

### Basic Usage

```python
from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint
from fastapi import FastAPI

app = FastAPI()
add_superoptix_fastapi_endpoint(app, agent_name="developer", path="/")
```

### Example with swe project

```python
from pathlib import Path
from fastapi import FastAPI
from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint

app = FastAPI()

# Point to the swe project directory
project_root = Path(__file__).parent.parent.parent.parent.parent / "swe"
add_superoptix_fastapi_endpoint(
    app,
    agent_name="developer",  # Matches swe/swe/agents/developer/
    project_root=project_root,
    path="/"
)
``` 