"""Versioned, owner-scoped native shared-state commits (contracts/shared-state-v1.md)."""

import copy
import json
import math
from ag_ui.core import StateSnapshotEvent
from ._util import get, maybe_await
from .types import BackendTool
from .context import attach_system, prefixed_text

NAME = "ag_ui_update_state"
HEADER = "AG-UI shared state v1\n"
SCHEMA = {
    "type": "object",
    "properties": {
        "operation": {"type": "string", "enum": ["replace", "merge_patch"]},
        "state": {"type": "object"},
        "patch": {"type": "object"},
        "expectedRevision": {"type": "integer", "minimum": 0},
    },
    "required": ["operation", "expectedRevision"],
    "additionalProperties": False,
}
DESCRIPTION = "Update shared application state. Read the latest AG-UI shared state v1 snapshot. Supply its expectedRevision. replace replaces the whole object; merge_patch recursively merges objects, deletes null members, and replaces arrays."


def validate(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str) or key in (
                "__proto__",
                "constructor",
                "prototype",
            ):
                raise ValueError("Unsafe shared-state key")
            validate(item)
    elif isinstance(value, list):
        for item in value:
            validate(item)
    elif value is not None and not isinstance(value, (str, bool, int, float)):
        raise ValueError("Shared state must be JSON")
    elif isinstance(value, float) and not math.isfinite(value):
        raise ValueError("Shared state must be finite JSON")


def same(left, right):
    """JSON equality: booleans are distinct from numbers, including nested values."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            same(value, right[key]) for key, value in left.items()
        )
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(same(a, b) for a, b in zip(left, right))
    return left == right


def envelope(record, state):
    validate(state)
    if not isinstance(state, dict):
        raise ValueError("Shared state must be an object")
    revision = record.state_revision + (not same(state, record.shared_state))
    if revision > 9007199254740991:
        raise ValueError("Shared-state revision exhausted")
    return {
        "version": 1,
        "owner": {"sessionId": record.session_id, "sessionThreadId": None},
        "revision": revision,
        "kind": "snapshot",
        "state": copy.deepcopy(state),
    }


def encode(value):
    return HEADER + json.dumps(
        value, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    )


def decode(content, record):
    if record.session_thread_id:
        return None
    text = prefixed_text(content, HEADER)
    if text is None:
        return None
    try:
        value = json.loads(text[len(HEADER) :])
        if (
            not isinstance(value, dict)
            or type(value.get("version")) is not int
            or value["version"] != 1
            or value.get("kind") != "snapshot"
        ):
            return None
        if value.get("owner") != {
            "sessionId": record.session_id,
            "sessionThreadId": None,
        }:
            return None
        rev = value.get("revision")
        if (
            type(rev) is not int
            or not 1 <= rev <= 9007199254740991
            or not isinstance(value.get("state"), dict)
        ):
            return None
        validate(value["state"])
        return value
    except (ValueError, TypeError):
        return None


def apply(record, value, emit=None):
    if value["revision"] <= record.state_revision:
        return
    record.shared_state = copy.deepcopy(value["state"])
    record.state_revision = value["revision"]
    if emit:
        emit(StateSnapshotEvent(snapshot=copy.deepcopy(record.shared_state)))


def restore(history, record, emit):
    # Native history is authoritative; a local cache cannot invent a commit.
    record.shared_state = None
    record.state_revision = 0
    seen, calls = set(), set()
    for event in history:
        eid = get(event, "id")
        if eid and eid in seen:
            continue
        if eid:
            seen.add(eid)
        if (
            get(event, "session_thread_id") not in (None, record.primary_thread_id)
            or get(event, "session_id", record.session_id) != record.session_id
        ):
            continue
        kind = get(event, "type")
        if kind == "agent.custom_tool_use" and get(event, "name") == NAME:
            calls.add(eid)
        eligible = kind == "system.message" or (
            kind == "user.custom_tool_result"
            and get(event, "is_error") is False
            and get(event, "custom_tool_use_id") in calls
        )
        if eligible:
            value = decode(get(event, "content"), record)
            if value:
                apply(record, value)
    if record.shared_state is not None and not record.session_thread_id:
        emit(StateSnapshotEvent(snapshot=copy.deepcopy(record.shared_state)))


def attach(events, state, record):
    if state is None or same(state, record.shared_state) or record.session_thread_id:
        return None
    value = envelope(record, state)
    results = [
        e
        for e in events
        if e["type"] in ("user.custom_tool_result", "user.tool_result")
    ]
    users = [e for e in events if e["type"] == "user.message"]
    if not results and not users:
        return None
    companion = (results or users)[-1]
    attach_system(events, companion, encode(value))
    return value, bool(results)


def merge(target, patch):
    result = copy.deepcopy(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = (
                merge(result.get(key), value)
                if isinstance(value, dict)
                else copy.deepcopy(value)
            )
    return result


def backend(record, emit, persist, client):
    async def handler(args):
        if record.session_thread_id:
            raise ValueError("Shared-state writes are primary-only")
        if (
            not isinstance(args, dict)
            or type(args.get("expectedRevision")) is not int
            or args["expectedRevision"] != record.state_revision
        ):
            raise ValueError("Stale or invalid expectedRevision")
        validate(args)
        op = args.get("operation")
        value = args.get("state" if op == "replace" else "patch")
        if op not in ("replace", "merge_patch") or not isinstance(value, dict):
            raise ValueError("Expected replace state or merge_patch patch object")
        if op == "merge_patch" and not value and record.shared_state is None:
            return "Shared state unchanged."
        return encode(
            envelope(
                record, value if op == "replace" else merge(record.shared_state, value)
            )
        )

    async def committed(text):
        value = decode([{"type": "text", "text": text}], record)
        if value:
            apply(record, value, emit)
            await maybe_await(persist())

    async def accepts(event):
        await discover_primary(client, record, [event])
        if record.session_thread_id or get(event, "session_thread_id") not in (
            None,
            record.primary_thread_id,
        ):
            return False
        if record.adopted:
            await ensure_catalog_client(client, record, allow_append=False)
        return True

    return BackendTool(NAME, DESCRIPTION, SCHEMA, handler, committed, accepts)


async def ensure_catalog(agent, record):
    await ensure_catalog_client(agent.client, record, allow_append=True)


async def ensure_catalog_client(client, record, *, allow_append):
    """Append to the actual imported catalog, never replace it with frontend tools."""
    session = await client.beta.sessions.retrieve(record.session_id)
    config = get(session, "agent")
    tools = get(config, "tools")
    if tools is None:
        agent_id = get(config, "id")
        if not agent_id or type(get(config, "version")) is not int:
            raise ValueError("Imported session tool catalog is unavailable")
        kwargs = (
            {"version": get(config, "version")}
            if get(config, "version") is not None
            else {}
        )
        agent_definition = await client.beta.agents.retrieve(agent_id, **kwargs)
        tools = get(agent_definition, "tools")
    if tools is None:
        raise ValueError("Imported session tool catalog is unavailable")
    from .content import plain

    tools = [plain(tool) for tool in tools]
    reserved = [tool for tool in tools if get(tool, "name") == NAME]
    if reserved:
        if len(reserved) != 1 or reserved[0] != definition():
            raise ValueError("Reserved shared-state tool name conflict")
        return
    if not allow_append:
        raise ValueError(
            "Imported shared-state tool is absent; install at a safe user-turn boundary"
        )
    await client.beta.sessions.update(
        record.session_id,
        agent={
            "tools": [
                *tools,
                {
                    "type": "custom",
                    "name": NAME,
                    "description": DESCRIPTION,
                    "input_schema": SCHEMA,
                },
            ]
        },
    )


async def discover_primary(client, record, history):
    if (
        record.session_thread_id
        or record.primary_thread_id
        or not any(
            get(e, "session_thread_id")
            and (get(e, "name") == NAME or get(e, "type") == "system.message")
            for e in history
        )
    ):
        return
    from .recovery import history_list

    threads = await history_list(client.beta.sessions.threads, record.session_id)
    primaries = [
        get(t, "id")
        for t in threads
        if get(t, "parent_thread_id") is None
        and get(t, "session_id", record.session_id) == record.session_id
    ]
    if len(primaries) != 1:
        raise ValueError("Cannot identify primary shared-state owner")
    record.primary_thread_id = primaries[0]


def definition():
    return {
        "type": "custom",
        "name": NAME,
        "description": DESCRIPTION,
        "input_schema": SCHEMA,
    }
