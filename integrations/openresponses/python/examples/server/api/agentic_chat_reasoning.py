"""Agentic Chat with Reasoning feature using OpenResponses."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from ag_ui_openresponses import create_openresponses_proxy

CONFIGS_DIR = str(Path(__file__).resolve().parent.parent / "configs")

app = APIRouter()

create_openresponses_proxy(app, path="/", config_dir=CONFIGS_DIR)
