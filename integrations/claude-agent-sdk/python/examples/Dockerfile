FROM python:3.11-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Copy the claude-agent-sdk python package (SDK + examples)
COPY integrations/claude-agent-sdk/python/ ./

# Install SDK and all dependencies (covers everything examples need)
RUN uv pip install --system -e .

WORKDIR /app/examples

CMD ["python", "server.py"]
