"""Agentic Chat feature using OpenResponses."""

from __future__ import annotations

import os

from fastapi import APIRouter

from ag_ui_openresponses import (
    OpenClawProviderConfig,
    OpenResponsesAgent,
    OpenResponsesAgentConfig,
    create_openresponses_endpoint,
)

app = APIRouter()

agent = OpenResponsesAgent(
    OpenResponsesAgentConfig(
        base_url="http://host.docker.internal:18789",
        api_key=os.environ.get("OPENCLAW_TOKEN", ""),
        default_model="openclaw",
        openclaw=OpenClawProviderConfig(),
    )
)

create_openresponses_endpoint(app, agent, path="/")
