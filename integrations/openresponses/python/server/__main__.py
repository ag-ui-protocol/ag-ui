"""Entry point: ``python -m server``."""

import os

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run("server:app", host="0.0.0.0", port=port)
