from __future__ import annotations

import dotenv
dotenv.load_dotenv()

import os
import uvicorn
from fastapi import FastAPI

from server.api import router

app = FastAPI(title="Agent-Spec x AG-UI Examples")
app.include_router(router)


def main():
    port = int(os.getenv("PORT", "9003"))
    uvicorn.run("server:app", host="0.0.0.0", port=port, reload=True)


__all__ = ["main"]
