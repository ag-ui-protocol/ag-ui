"""End-to-end probe for ADK streamed function-call arguments.

Two layers are exercised so a failure can be pinned to the right one:

  --layer adk   Raw google-adk Runner (SSE). Prints every partial FunctionCall
                (name / partial_args / will_continue). Shows what ADK itself
                delivers for the chosen model.
  --layer agui  Full ag_ui_adk.ADKAgent path. Collects AG-UI TOOL_CALL_* events
                and checks that args arrive as >1 incremental TOOL_CALL_ARGS
                deltas that concatenate to valid JSON.

Usage (from this example directory):
  ./run.sh replay probe --layer agui
  ./run.sh replay probe --layer adk
  ./run.sh probe --model openai/gpt-4o-mini

Exit code: 0 = streaming works, 1 = not streamed / failed, 2 = setup error.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
import uuid
import warnings
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).parent
load_dotenv(HERE / ".env")
os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "FALSE")
os.environ.setdefault("GEMINI_API_KEY", os.getenv("GOOGLE_API_KEY", ""))

from ag_ui.core import (
    EventType,
    RunAgentInput,
)
from ag_ui.core import Tool as AGUITool  # noqa: E402
from ag_ui.core import (
    UserMessage,
)
from google.adk.agents import LlmAgent  # noqa: E402
from google.genai import types  # noqa: E402

from ag_ui_adk import ADKAgent, AGUIToolset  # noqa: E402

PROMPT = (
    "Create a detailed onboarding guide for backend engineers. Call the "
    "write_document tool exactly once with a long `content` (at least 6 "
    "paragraphs) and a short `title`. Do not answer with plain text."
)

DOC_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "description": "Short document title"},
        "content": {"type": "string", "description": "Full markdown body (long)"},
    },
    "required": ["title", "content"],
}


def write_document(title: str, content: str) -> dict:
    """Write a document (backend tool variant).

    Args:
        title: Short document title.
        content: Full markdown body.
    """
    return {"status": "ok", "title": title, "chars": len(content)}


def build_agent(model: str, tool_kind: str, stream_fc_args: bool) -> LlmAgent:
    cfg = None
    if (
        model != "replay"
        and "/" not in model
        and os.getenv("GEMINI_SEND_STREAM_FLAG") == "1"
    ):
        cfg = types.GenerateContentConfig(
            tool_config=types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    stream_function_call_arguments=True
                )
            )
        )
    tools = [AGUIToolset()] if tool_kind == "client" else [write_document]
    if model == "replay":
        os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")
        from replay_llm import replay_model

        model = replay_model()
    elif "/" in model:  # LiteLLM id, e.g. openai/gpt-4o-mini
        from google.adk.models.lite_llm import LiteLlm

        extra = (
            {"reasoning_effort": os.environ["E2E_REASONING_EFFORT"]}
            if os.getenv("E2E_REASONING_EFFORT")
            else {}
        )
        model = LiteLlm(model=model, **extra)
    return LlmAgent(
        name="writer",
        model=model,
        instruction="You are a document-writing assistant. Always use write_document.",
        tools=tools,
        generate_content_config=cfg,
    )


def check_env(model: str) -> None:
    if model != "replay" and "/" not in model:
        if os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").upper() not in (
            "1",
            "TRUE",
        ) and not os.getenv("GOOGLE_API_KEY"):
            print("setup error: set GOOGLE_API_KEY for the Gemini API", file=sys.stderr)
            sys.exit(2)


async def run_adk_layer(agent: LlmAgent) -> int:
    from google.adk.agents.run_config import RunConfig, StreamingMode
    from google.adk.runners import InMemoryRunner

    runner = InMemoryRunner(agent=agent, app_name="e2e")
    session = await runner.session_service.create_session(app_name="e2e", user_id="u")
    partial_fc = 0
    final_fc = 0
    try:
        async for ev in runner.run_async(
            user_id="u",
            session_id=session.id,
            new_message=types.Content(role="user", parts=[types.Part(text=PROMPT)]),
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        ):
            for fc in ev.get_function_calls() or []:
                partial_args = getattr(fc, "partial_args", None) or []
                will_continue = getattr(fc, "will_continue", None)
                pa = [(p.json_path, (p.string_value or "")[:30]) for p in partial_args]
                print(
                    f"[adk] partial={ev.partial} name={fc.name!r} will_continue={will_continue} "
                    f"partial_args={pa} args_keys={list((fc.args or {}).keys())}"
                )
                # Incremental = carries partial_args or will_continue. A partial event that
                # already holds the complete args (Gemini API) is NOT streaming.
                if ev.partial and (partial_args or will_continue):
                    partial_fc += 1
                else:
                    final_fc += 1
    except Exception as e:  # noqa: BLE001
        print(f"[adk] ERROR: {type(e).__name__}: {str(e)[:500]}")
        return 1
    print(f"\n[adk] incremental function_call events={partial_fc} final={final_fc}")
    ok = partial_fc > 0 and final_fc > 0
    print(
        "RESULT:",
        (
            "PASS - ADK streams partial FC args"
            if ok
            else "FAIL - ADK emitted no incremental FC args (args arrive complete)"
        ),
    )
    return 0 if ok else 1


async def run_agui_layer(agent: LlmAgent, tool_kind: str, stream_fc_args: bool) -> int:
    adk = ADKAgent(
        adk_agent=agent,
        app_name="e2e",
        user_id="u",
        use_in_memory_services=True,
        streaming_function_call_arguments=stream_fc_args,
    )
    tools = (
        [
            AGUITool(
                name="write_document",
                description="Write a markdown document.",
                parameters=DOC_SCHEMA,
            )
        ]
        if tool_kind == "client"
        else []
    )
    inp = RunAgentInput(
        thread_id=f"t-{uuid.uuid4().hex[:8]}",
        run_id=f"r-{uuid.uuid4().hex[:8]}",
        messages=[UserMessage(id="u1", role="user", content=PROMPT)],
        tools=tools,
        context=[],
        state={},
        forwarded_props={},
    )
    t0 = time.monotonic()
    starts: dict[str, str] = {}
    args: dict[str, list[tuple[float, str]]] = {}
    ends: set[str] = set()
    error = None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        async for ev in adk.run(inp):
            t = time.monotonic() - t0
            if ev.type == EventType.TOOL_CALL_START:
                starts[ev.tool_call_id] = ev.tool_call_name
                print(
                    f"[{t:5.2f}s] TOOL_CALL_START {ev.tool_call_name} id={ev.tool_call_id[:8]}"
                )
            elif ev.type == EventType.TOOL_CALL_ARGS:
                args.setdefault(ev.tool_call_id, []).append((t, ev.delta))
                print(f"[{t:5.2f}s] TOOL_CALL_ARGS  +{len(ev.delta)} chars")
            elif ev.type == EventType.TOOL_CALL_END:
                ends.add(ev.tool_call_id)
                print(f"[{t:5.2f}s] TOOL_CALL_END   id={ev.tool_call_id[:8]}")
            elif ev.type == EventType.RUN_ERROR:
                error = ev.message
                print(f"[{t:5.2f}s] RUN_ERROR {ev.message[:400]}")

    print()
    if error:
        print("RESULT: FAIL - run errored (see RUN_ERROR above)")
        return 1
    if not starts:
        print("RESULT: FAIL - no TOOL_CALL_START emitted at all")
        return 1
    rc = 0
    for cid, name in starts.items():
        deltas = args.get(cid, [])
        joined = "".join(d for _, d in deltas)
        try:
            parsed = json.loads(joined)
            valid = isinstance(parsed, dict) and bool(parsed)
        except json.JSONDecodeError:
            valid = False
        spread = (deltas[-1][0] - deltas[0][0]) if len(deltas) > 1 else 0.0
        incremental = len(deltas) > 1 and spread > 0.05
        print(
            f"tool={name} id={cid[:8]} args_events={len(deltas)} spread={spread:.2f}s "
            f"valid_json={valid} ended={cid in ends}"
        )
        if not (incremental and valid and cid in ends):
            rc = 1
    print(
        "RESULT:",
        (
            "PASS - args streamed incrementally"
            if rc == 0
            else "FAIL - args NOT streamed incrementally (single blob / invalid / not closed)"
        ),
    )
    return rc


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--layer", choices=["agui", "adk"], default="agui")
    ap.add_argument("--tool", choices=["client", "backend"], default="client")
    ap.add_argument("--model", default=os.getenv("E2E_MODEL", "replay"))
    ap.add_argument(
        "--no-stream-fc-args",
        dest="stream",
        action="store_false",
        help="disable the Gemini-oriented middleware opt-in; LRO partial events still stream",
    )
    ap.set_defaults(
        stream=os.getenv("STREAM_FC_ARGS", "0").lower() in ("1", "true", "yes", "on")
    )
    a = ap.parse_args()
    check_env(a.model)
    print(f"model={a.model} layer={a.layer} tool={a.tool} stream_fc_args={a.stream}\n")
    if a.layer == "adk":
        a.tool = "backend"  # AGUIToolset is only resolvable through ADKAgent
    agent = build_agent(a.model, a.tool, a.stream)
    if a.layer == "adk":
        return asyncio.run(run_adk_layer(agent))
    return asyncio.run(run_agui_layer(agent, a.tool, a.stream))


if __name__ == "__main__":
    sys.exit(main())
