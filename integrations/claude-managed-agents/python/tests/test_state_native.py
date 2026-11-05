import json
import subprocess
import sys
from ag_ui_claude_managed_agents.state import HEADER


def test_installed_sdk_subprocess_reads_and_updates_over_localhost():
    result = subprocess.run(
        [sys.executable, "-m", "tests.native_state_provider"],
        capture_output=True,
        text=True,
        timeout=25,
        check=True,
    )
    output = json.loads(result.stdout)
    assert output["agUiEvents"][-1]["type"] == "RUN_FINISHED", output
    snapshots = [
        e["snapshot"] for e in output["agUiEvents"] if e["type"] == "STATE_SNAPSHOT"
    ]
    assert snapshots == [
        {"board": {"count": 1, "obsolete": "remove"}},
        {"board": {"count": 2}},
    ]
    systems = [e for e in output["events"] if e["type"] == "system.message"]
    assert len(systems) == 1 and len(systems[0]["content"]) == 2
    assert any(
        block["text"].startswith("AG-UI runtime context snapshot.")
        for block in systems[0]["content"]
    )
    native = next(e for e in output["events"] if e["type"] == "user.custom_tool_result")
    assert native["is_error"] is False
    commit = json.loads(native["content"][0]["text"][len(HEADER) :])
    assert commit["revision"] == 2 and commit["owner"] == {
        "sessionId": "sesn_native",
        "sessionThreadId": None,
    }
