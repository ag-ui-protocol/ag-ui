"""Generic OpenResponses proxy server."""

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from ag_ui_openresponses import create_openresponses_proxy

app = FastAPI(title="OpenResponses Proxy")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


restrict_configs = os.environ.get("OPENRESPONSES_RESTRICT_CONFIGS", "").lower() in (
    "true",
    "1",
    "yes",
)

create_openresponses_proxy(app, restrict_configs=restrict_configs)
