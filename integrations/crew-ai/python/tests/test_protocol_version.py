"""RUN_STARTED declares the AG-UI protocol version (PNI-524).

AG-UI 1.0 lets a producer state the protocol version it speaks on
``RUN_STARTED.protocolVersion``. ``StreamFrameTranslator`` builds RUN_STARTED
on ``flow_started`` and in ``ensure_run_started`` (resume / forced open); both
must set it from ``ag_ui.core.PROTOCOL_VERSION``.
"""

from types import SimpleNamespace

import pytest
from ag_ui.core import PROTOCOL_VERSION, EventType
from ag_ui_crewai._frames import StreamFrameTranslator


def _translator():
    return StreamFrameTranslator(
        thread_id="t-1", run_id="r-1", state_provider=dict
    )


@pytest.mark.parametrize(
    "emit",
    [
        lambda t: t.translate(SimpleNamespace(type="flow_started")),
        lambda t: t.ensure_run_started(),
    ],
    ids=["flow_started", "ensure_run_started"],
)
def test_translator_run_started_declares_protocol_version(emit):
    (event,) = emit(_translator())
    assert event.type == EventType.RUN_STARTED
    assert event.protocol_version == PROTOCOL_VERSION
