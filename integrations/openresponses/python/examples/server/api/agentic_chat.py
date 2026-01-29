"""Agentic Chat feature using OpenResponses."""

from __future__ import annotations

import os

from fastapi import APIRouter

from ag_ui_openresponses import (
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
    create_openresponses_endpoint,
)

app = APIRouter()

agent = OpenResponsesAgent(
    OpenResponsesAgentConfig(
        base_url="https://api.openai.com/v1",
        api_key=os.environ.get("OPENAI_API_KEY", ""),
        default_model="gpt-4o-mini",
    )
)

create_openresponses_endpoint(app, agent, path="/")
