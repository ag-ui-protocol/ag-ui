"""AG-UI integration for IBM watsonx orchestrate agents."""

from .agent import WatsonxAgent

__all__ = [
    "WatsonxAgent",
    "add_watsonx_fastapi_endpoint",
    "create_watsonx_app",
]


def __getattr__(name: str):
    if name == "add_watsonx_fastapi_endpoint":
        from .endpoint import add_watsonx_fastapi_endpoint

        return add_watsonx_fastapi_endpoint
    if name == "create_watsonx_app":
        from .utils import create_watsonx_app

        return create_watsonx_app
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
