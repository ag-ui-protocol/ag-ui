"""
Example SuperOptiX AG-UI server.
"""
import os
import uvicorn
from pathlib import Path
from fastapi import FastAPI
from dotenv import load_dotenv

from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint

load_dotenv()

app = FastAPI(title="SuperOptiX AG-UI Server")

# Add SuperOptiX endpoint
# You can specify the project root if needed
project_root = Path.cwd()  # or specify a specific path
add_superoptix_fastapi_endpoint(
    app, 
    agent_name="developer",  # Change this to your agent name
    project_root=project_root,
    path="/"
)

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "example_server:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )

if __name__ == "__main__":
    main() 