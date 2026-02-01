FROM python:3.12-slim

WORKDIR /app

# Install the ag_ui_openresponses package from PyPI
RUN pip install --no-cache-dir ag_ui_openresponses uvicorn

# Copy server files (build context = this server/ directory)
COPY configs/ ./configs/
COPY __init__.py __main__.py ./server/

EXPOSE 8080

CMD ["python", "-m", "server"]
