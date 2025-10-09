"""Example usage of the ADK middleware with FastAPI.

This provides a FastAPI application that demonstrates how to use the
ADK middleware with various agent types. It includes examples for
each of the ADK middleware features:
- Agentic Chat Agent
- Tool Based Generative UI
- Human in the Loop
- Shared State
- Predictive State Updates
"""

from __future__ import annotations

from fastapi import FastAPI
import uvicorn
import os


from .api import (
    agentic_chat_app,
    tool_based_generative_ui_app,
    human_in_the_loop_app,
    shared_state_app,
    backend_tool_rendering_app,
    # predictive_state_updates_app,
)

app = FastAPI(title='ADK Middleware Demo')

# Include routers instead of mounting apps to show routes in docs
app.include_router(agentic_chat_app.router, prefix='/chat', tags=['Agentic Chat'])
app.include_router(tool_based_generative_ui_app.router, prefix='/adk-tool-based-generative-ui', tags=['Tool Based Generative UI'])
app.include_router(human_in_the_loop_app.router, prefix='/adk-human-in-loop-agent', tags=['Human in the Loop'])
app.include_router(shared_state_app.router, prefix='/adk-shared-state-agent', tags=['Shared State'])
app.include_router(backend_tool_rendering_app.router, prefix='/backend_tool_rendering', tags=['Backend Tool Rendering'])
# app.include_router(predictive_state_updates_app.router, prefix='/adk-predictive-state-agent', tags=['Predictive State Updates'])


@app.get("/")
async def root():
    return {
        "message": "ADK Middleware is running!",
        "endpoints": {
            "chat": "/chat",
            "tool_based_generative_ui": "/adk-tool-based-generative-ui",
            "human_in_the_loop": "/adk-human-in-loop-agent",
            "shared_state": "/adk-shared-state-agent",
            "backend_tool_rendering": "/backend_tool_rendering",
            # "predictive_state_updates": "/adk-predictive-state-agent",
            "docs": "/docs"
        }
    }


def main():
    """Main function to start the FastAPI server."""
    # Check for authentication credentials
    google_api_key = os.getenv("GOOGLE_API_KEY")
    google_app_creds = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

    if not google_api_key and not google_app_creds:
        print("⚠️  Warning: No Google authentication credentials found!")
        print()
        print("   Google ADK uses environment variables for authentication:")
        print("   - API Key:")
        print("     ```")
        print("     export GOOGLE_API_KEY='your-api-key-here'")
        print("     ```")
        print("     Get a key from: https://makersuite.google.com/app/apikey")
        print()
        print("   - Or use Application Default Credentials (ADC):")
        print("     ```")
        print("     gcloud auth application-default login")
        print("     export GOOGLE_APPLICATION_CREDENTIALS='path/to/service-account.json'")
        print("     ```")
        print("     See docs here: https://cloud.google.com/docs/authentication/application-default-credentials")
        print()
        print("   The credentials will be automatically picked up from the environment")
        print()

    port = int(os.getenv("PORT", "8000"))
    print("Starting ADK Middleware server...")
    print(f"Available endpoints:")
    print(f"  • Chat: http://localhost:{port}/chat")
    print(f"  • Tool Based Generative UI: http://localhost:{port}/adk-tool-based-generative-ui")
    print(f"  • Human in the Loop: http://localhost:{port}/adk-human-in-loop-agent")
    print(f"  • Shared State: http://localhost:{port}/adk-shared-state-agent")
    # print(f"  • Predictive State Updates: http://localhost:{port}/adk-predictive-state-agent")
    print(f"  • API docs: http://localhost:{port}/docs")
    uvicorn.run(app, host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()

__all__ = ["main"]
