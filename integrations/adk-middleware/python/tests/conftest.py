"""Shared pytest fixtures for ADK middleware tests."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time
from pathlib import Path

import pytest

from ag_ui.core import SystemMessage as CoreSystemMessage

import ag_ui_adk.adk_agent as adk_agent_module

# ---------------------------------------------------------------------------
# LLMock server management
# ---------------------------------------------------------------------------

LLMOCK_DIR = Path(__file__).parent / "llmock"
LLMOCK_SERVER = LLMOCK_DIR / "server.mjs"
LLMOCK_FIXTURES = LLMOCK_DIR / "fixtures"


def _start_llmock() -> tuple[subprocess.Popen, str]:
    """Start the LLMock Node.js server and return (process, base_url)."""
    node = shutil.which("node")
    if node is None:
        pytest.skip("Node.js not available — cannot start LLMock server")

    # Ensure npm dependencies are installed
    node_modules = LLMOCK_DIR / "node_modules"
    if not node_modules.exists():
        subprocess.check_call(
            ["npm", "install", "--prefix", str(LLMOCK_DIR)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    proc = subprocess.Popen(
        [
            node,
            str(LLMOCK_SERVER),
            "--fixtures-dir", str(LLMOCK_FIXTURES),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(LLMOCK_DIR),
    )

    # Wait for "LLMOCK_READY <url>" on stdout
    deadline = time.monotonic() + 15
    url = None
    while time.monotonic() < deadline:
        line = proc.stdout.readline().decode().strip()
        if line.startswith("LLMOCK_READY "):
            url = line.split(" ", 1)[1]
            break
        if proc.poll() is not None:
            stderr_output = proc.stderr.read().decode()
            raise RuntimeError(f"LLMock server exited early: {stderr_output}")

    if url is None:
        proc.kill()
        raise RuntimeError("LLMock server did not become ready within 15 seconds")

    return proc, url


@pytest.fixture(scope="session")
def llmock_server():
    """Start a session-scoped LLMock server and inject env vars.

    Sets GOOGLE_GEMINI_BASE_URL and GOOGLE_API_KEY so that the google-genai
    client routes all Gemini API calls to the mock server.
    """
    # Skip if a real GOOGLE_API_KEY is already set (prefer real API)
    if os.environ.get("GOOGLE_API_KEY"):
        yield None
        return

    proc, url = _start_llmock()

    # Inject env vars that the google-genai client reads
    os.environ["GOOGLE_GEMINI_BASE_URL"] = url
    os.environ["GOOGLE_API_KEY"] = "fake-gemini-key-for-llmock"

    yield url

    # Cleanup
    os.environ.pop("GOOGLE_GEMINI_BASE_URL", None)
    os.environ.pop("GOOGLE_API_KEY", None)

    proc.send_signal(signal.SIGTERM)
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


# ---------------------------------------------------------------------------
# Existing fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def restore_system_message_class():
    """Ensure every test starts and ends with the real SystemMessage type."""

    adk_agent_module.SystemMessage = CoreSystemMessage
    try:
        yield
    finally:
        adk_agent_module.SystemMessage = CoreSystemMessage
