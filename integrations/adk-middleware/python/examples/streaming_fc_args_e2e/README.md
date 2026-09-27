# Progressive ADK tool-call argument streaming

A lightweight reproduction of the Python ADK middleware's frontend-tool argument streaming. A FastAPI server serves a standalone HTML page and an AG-UI endpoint. No Node installation, frontend build, or CopilotKit dependency is required.

The page displays `TOOL_CALL_ARGS` deltas as they arrive, an event timeline, argument JSON validity, and whether `TOOL_CALL_END` arrived. These are **arguments being generated**, not output from an executing tool. The page observes the frontend tool call but does not execute or resume it.

## Quick start (no credentials)

Requirements: [uv](https://docs.astral.sh/uv/) and an internet connection for initial dependency installation. The scripts request Python 3.12 and install this checkout's middleware in editable mode with ADK 2.10.0 into a local `.venv-e2e` environment.

From `integrations/adk-middleware/python/examples/streaming_fc_args_e2e`:

```sh
./run.sh replay
```

Open <http://127.0.0.1:8010> and select **Run agent**. Expect multiple incremental argument events, valid completed JSON, and a **PASS** verdict. Stop the server with Ctrl+C.

Replay uses ADK's real LiteLLM adapter and Runner. Only the provider completion is replaced with deterministic tool-call fragments, with a short delay between chunks. No `.env` file or API key is required, and replay does not make a model API request.

```sh
# Prevent browser auto-opening, or choose another port.
NO_OPEN=1 PORT=8012 ./run.sh replay

# Two diagnostic layers, without starting an HTTP server.
./run.sh replay probe --layer adk
./run.sh replay probe --layer agui

# Run both focused regression files (including parallel and resumable calls).
./run_test.sh
```

The headless AG-UI probe defaults to a client/frontend tool. Its PASS verdict requires multiple deltas spread over more than 50 ms, valid JSON, and a completed call. Timing thresholds are diagnostic heuristics: a very fast live response can fail that timing check even if its arguments arrive incrementally. The automated tests assert event counts, ordering, and argument correctness without that timing threshold.

## Configuration and live providers

The default model is `replay`; the default `STREAM_FC_ARGS=0` shows that streamed LRO arguments do not need the Gemini-oriented middleware opt-in. An optional `.env` supplies live-provider configuration:

```sh
cp .env.example .env
# Edit E2E_MODEL and the selected provider's credentials, then:
./run.sh
```

Exported environment variables take precedence over `.env`. `./run.sh replay` explicitly selects replay even if `.env` selects a live provider.

- `E2E_MODEL`: `replay`, a LiteLLM ID such as `openai/gpt-4o-mini` or `azure/<deployment>`, or a native Gemini model name.
- `E2E_REASONING_EFFORT`: optional LiteLLM model parameter; availability depends on the model/provider.
- `STREAM_FC_ARGS`: controls the existing Gemini-oriented middleware flag. LRO partial events are handled independently of this flag.
- `GEMINI_SEND_STREAM_FLAG`: defaults to `0`. The Gemini Developer API rejects that request option in the reported setup; enabling it probes the rejection rather than enabling unsupported provider behavior.
- `REPLAY_CHUNK_DELAY_S`: defaults to `0.03` seconds.
- `PORT`, `NO_OPEN`, `ADK_VERSION`: shell runner options; export them or prefix the command. They are not loaded from `.env` by the shell.

`GET /config` reports the active model, ADK version, middleware flag, and loaded middleware source. Initial dependency installation requires network access; live models require their provider's credentials and incur normal provider usage.

## ADK versions and provider limitations

[ADK #6630](https://github.com/google/adk-python/issues/6630) was implemented in [f449780](https://github.com/google/adk-python/commit/f44978013378ecba9e3cfc0c955b7890ceb7951b), listed in [ADK 2.10.0](https://github.com/google/adk-python/releases/tag/v2.10.0). That release supplies cross-adapter partial arguments that this example exercises.

To compare upstream behavior, use `ADK_VERSION=1.35.0 ./run.sh replay probe --layer adk`. Older ADK adapters may emit only completed arguments, yielding FAIL in a probe requiring progressive streaming. The LiteLLM integration tests skip when the upstream capability is absent; a skip is not proof of backward-compatibility validation.

Changing `ADK_VERSION` rebuilds the example's environment. `./run.sh reset` removes only that local environment. The production middleware's dependency range is not raised by this example.

## Files

- `server.py`: agent, AG-UI endpoint, page, and configuration endpoint.
- `index.html`: vanilla-JavaScript SSE reader and argument-stream diagnostic UI.
- `replay_llm.py`: deterministic provider-style completion replay.
- `run_e2e.py`: raw ADK and AG-UI headless probes; `--tool backend` is available for comparing the separate backend-tool path.
- `run.sh` / `run_test.sh`: isolated setup and execution helpers.

Keep `.env`, `.venv-e2e`, and Python caches local; they are ignored by Git.
