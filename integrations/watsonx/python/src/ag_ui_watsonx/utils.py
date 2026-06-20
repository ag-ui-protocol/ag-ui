"""Convenience factory for creating a watsonx AG-UI FastAPI app."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from fastapi import FastAPI

from .agent import WatsonxAgent


def create_watsonx_app(
    agent: WatsonxAgent,
    path: str = "/",
    origins: list[str] | None = None,
) -> "FastAPI":
    from fastapi import FastAPI
    from fastapi.middleware.cors import CORSMiddleware
    from .endpoint import add_watsonx_fastapi_endpoint

    app = FastAPI(title=f"watsonx orchestrate - {agent.name}")

    cors_origins = origins or ["*"]
    is_wildcard = "*" in cors_origins
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=bool(origins) and not is_wildcard,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    add_watsonx_fastapi_endpoint(app, agent, path)

    return app
