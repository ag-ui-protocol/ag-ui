"""E2E server: AG-UI endpoint (ADK middleware) + the static test webapp.

  GET  /          -> index.html (the webapp)
  GET  /config    -> active model / flags, shown in the webapp header
  POST /agent     -> AG-UI SSE endpoint (ag_ui_adk)

Env (from .env):
  E2E_MODEL            replay (default, no credentials) | any LiteLLM id containing "/",
                       e.g. openai/gpt-4o-mini, anthropic/claude-haiku-4-5-20251001  |
                       replay (no key: fake LiteLLM model streaming realistic arg fragments)
  E2E_REASONING_EFFORT none|minimal|low|... passed to LiteLLM (use "none" for Azure gpt-5.4+ to stay
                       on Chat Completions instead of the auto-bridged Responses API)
  STREAM_FC_ARGS       0 (default) -> use ADK partial events without the Gemini opt-in
  GEMINI_SEND_STREAM_FLAG 0 (default) -> do NOT put stream_function_call_arguments in the Gemini
                       generate config (the Gemini API rejects it with a ValueError). Set 1 to see
                       that rejection surface as RUN_ERROR.
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "FALSE")
os.environ.setdefault("GEMINI_API_KEY", os.getenv("GOOGLE_API_KEY", ""))

from fastapi import FastAPI  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from google.adk.agents import LlmAgent  # noqa: E402
from google.genai import types  # noqa: E402

from ag_ui_adk import ADKAgent, AGUIToolset, add_adk_fastapi_endpoint  # noqa: E402


def _flag(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in ("1", "true", "yes", "on")


MODEL = os.getenv("E2E_MODEL", "replay")
STREAM_FC_ARGS = _flag("STREAM_FC_ARGS", "0")
GEMINI_SEND_STREAM_FLAG = _flag("GEMINI_SEND_STREAM_FLAG", "0")
IS_REPLAY = MODEL == "replay"
IS_LITELLM = IS_REPLAY or "/" in MODEL
if IS_REPLAY:
    os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")


def build_model():
    if IS_REPLAY:
        from replay_llm import replay_model

        return replay_model()
    if IS_LITELLM:
        from google.adk.models.lite_llm import LiteLlm

        kwargs = {}
        # gpt-5.4+ on Azure/OpenAI: with function tools and reasoning on, LiteLLM silently
        # switches to the Responses API (api-version=preview, ignores AZURE_API_VERSION).
        # E2E_REASONING_EFFORT=none keeps plain Chat Completions.
        if os.getenv("E2E_REASONING_EFFORT"):
            kwargs["reasoning_effort"] = os.environ["E2E_REASONING_EFFORT"]
        return LiteLlm(model=MODEL, **kwargs)
    return MODEL


def build_agent() -> LlmAgent:
    cfg = None
    if not IS_LITELLM and GEMINI_SEND_STREAM_FLAG:
        cfg = types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    stream_function_call_arguments=True
                )
            ),
            thinking_config=types.ThinkingConfig(
                thinking_level=types.ThinkingLevel.LOW
            ),
        )
    return LlmAgent(
        name="writer",
        model=build_model(),
        instruction=(
            "You are a document-writing assistant. When asked to write a document, you MUST call "
            "the write_document tool exactly once with a long markdown `content`. Never answer "
            "with plain text instead of calling the tool."
        ),
        tools=[AGUIToolset()],  # write_document is supplied by the webapp
        generate_content_config=cfg,
    )


agent = ADKAgent(
    adk_agent=build_agent(),
    app_name="streaming_fc_args_e2e",
    user_id="e2e_user",
    use_in_memory_services=True,
    streaming_function_call_arguments=STREAM_FC_ARGS,
)

app = FastAPI(title="Streaming FC args E2E")
add_adk_fastapi_endpoint(app, agent, path="/agent")


@app.get("/config")
def config() -> dict:
    from google.adk import __version__ as adk_version

    import ag_ui_adk

    return {
        "model": MODEL,
        "provider": (
            "replay (fake litellm)"
            if IS_REPLAY
            else "litellm" if IS_LITELLM else "gemini-api"
        ),
        "vertex": os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").upper() in ("1", "TRUE"),
        "middleware_streaming_flag": agent._streaming_function_call_arguments,
        "gemini_stream_flag_sent": bool(not IS_LITELLM and GEMINI_SEND_STREAM_FLAG),
        "adk_version": adk_version,
        "middleware_source": str(Path(ag_ui_adk.__file__).resolve()),
    }


@app.get("/")
def index() -> FileResponse:
    return FileResponse(HERE / "index.html")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8010")))
