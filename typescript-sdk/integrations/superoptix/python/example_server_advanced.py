"""
Advanced SuperOptiX AG-UI server example.
"""
import os
import uvicorn
from pathlib import Path
from fastapi import FastAPI
from dotenv import load_dotenv

from ag_ui_superoptix.endpoint import add_superoptix_fastapi_endpoint

load_dotenv()

app = FastAPI(title="SuperOptiX AG-UI Server - Advanced Example")

# Example 1: Using the swe project with developer agent
project_root_swe = Path(__file__).parent.parent.parent.parent.parent / "swe"
add_superoptix_fastapi_endpoint(
    app,
    agent_name="developer",
    project_root=project_root_swe,
    path="/developer"
)

# Example 2: Using a different project (if you have one)
# project_root_other = Path("/path/to/your/superoptix/project")
# add_superoptix_fastapi_endpoint(
#     app,
#     agent_name="your_agent_name",
#     project_root=project_root_other,
#     path="/your_agent"
# )

# Example 3: Using current directory (if running from a SuperOptiX project)
# add_superoptix_fastapi_endpoint(
#     app,
#     agent_name="your_agent",
#     project_root=Path.cwd(),
#     path="/current_project"
# )

def main():
    """Run the uvicorn server."""
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run(
        "example_server_advanced:app",
        host="0.0.0.0",
        port=port,
        reload=True
    )

if __name__ == "__main__":
    main() 