import pytest

from .fake_client import FakeClient
from .test_agent import IDLE_END_TURN, base_input, new_agent


async def run(messages):
    fake = FakeClient(streams=[[IDLE_END_TURN]])
    value = base_input(messages=messages)
    original = value.model_dump(mode="json", by_alias=True, exclude_none=True)
    events = [
        event.model_dump(mode="json", by_alias=True, exclude_none=True)
        async for event in new_agent(fake).run(value)
    ]
    assert events[0]["input"] == original
    assert value.model_dump(mode="json", by_alias=True, exclude_none=True) == original
    return fake, events


@pytest.mark.parametrize("data", ["%%%", "/w=="])
@pytest.mark.parametrize("malformed_last", [False, True])
async def test_first_contact_validates_only_newest_user_message(data, malformed_last):
    malformed = {
        "id": "malformed", "role": "user",
        "content": [{"type": "document", "source": {"type": "data", "value": data, "mimeType": "text/plain"}}],
    }
    corrected = {"id": "corrected", "role": "user", "content": "corrected message"}
    fake, events = await run([corrected, malformed] if malformed_last else [malformed, corrected])
    if malformed_last:
        assert events[-1]["type"] == "RUN_ERROR"
        assert len([event for event in events if event["type"] == "RUN_ERROR"]) == 1
        assert fake.create_calls == []
        assert fake.sent == []
    else:
        assert events[-1]["type"] == "RUN_FINISHED"
        assert len(fake.create_calls) == 1
        assert len(fake.sent) == 1
        assert {"type": "user.message", "content": [{"type": "text", "text": "corrected message"}]} in fake.sent[0]["events"]


async def test_first_contact_does_not_create_from_older_text_when_newest_user_is_blank():
    fake, events = await run([
        {"id": "old", "role": "user", "content": "older message"},
        {"id": "new", "role": "user", "content": " \n"},
    ])
    assert events[-1]["type"] == "RUN_ERROR"
    assert fake.create_calls == []
    assert fake.sent == []


def malformed_message(data):
    return {
        "id": "malformed", "role": "user",
        "content": [{"type": "document", "source": {"type": "data", "value": data, "mimeType": "text/plain"}}],
    }


async def collect(agent, messages):
    return [
        event.model_dump(mode="json", by_alias=True, exclude_none=True)
        async for event in agent.run(base_input(messages=messages))
    ]


@pytest.mark.parametrize("data", ["%%%", "/w=="])
async def test_existing_session_does_not_revalidate_delivered_history(data):
    fake = FakeClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    agent = new_agent(fake)
    corrected = {"id": "corrected", "role": "user", "content": "corrected message"}
    assert (await collect(agent, [malformed_message(data), corrected]))[-1]["type"] == "RUN_FINISHED"
    events = await collect(agent, [
        malformed_message(data), corrected, {"id": "next", "role": "user", "content": "next message"},
    ])
    assert events[-1]["type"] == "RUN_FINISHED"
    assert len(fake.create_calls) == 1
    assert fake.sent[-1]["events"] == [{"type": "user.message", "content": [{"type": "text", "text": "next message"}]}]


@pytest.mark.parametrize("data", ["%%%", "/w=="])
async def test_existing_session_rejects_malformed_newest_user_message(data):
    fake = FakeClient(streams=[[IDLE_END_TURN], [IDLE_END_TURN]])
    agent = new_agent(fake)
    corrected = {"id": "corrected", "role": "user", "content": "corrected message"}
    assert (await collect(agent, [corrected]))[-1]["type"] == "RUN_FINISHED"
    sent = list(fake.sent)
    events = await collect(agent, [corrected, malformed_message(data)])
    assert events[-1]["type"] == "RUN_ERROR"
    assert events[-1]["code"] == "run_failed"
    assert fake.sent == sent
