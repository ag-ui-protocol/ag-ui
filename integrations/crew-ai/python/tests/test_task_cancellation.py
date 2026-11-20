"""Error-code sanitization and wire correlation helpers."""
import pytest
from ag_ui.core import RunStartedEvent

def test_sanitize_exception_code_direct():
    """Sanitize replaces non ``[A-Z0-9_]`` chars
    with ``_`` and upper-cases the result.

    Covers edge cases the integration test above cannot easily
    reproduce (names with spaces, unicode, leading digits, etc.).
    """
    from ag_ui_crewai.endpoint import _sanitize_exception_code

    # Pure ASCII alnum — upper-cased, digits preserved.
    assert _sanitize_exception_code("RuntimeError") == "RUNTIMEERROR"
    assert _sanitize_exception_code("WeirdError42") == "WEIRDERROR42"
    # Dot-qualified and dash-containing names: non-[A-Z0-9_] -> _.
    assert _sanitize_exception_code("foo.bar") == "FOO_BAR"
    assert _sanitize_exception_code("my-error") == "MY_ERROR"
    # Unicode: non-ASCII characters replaced with _, then the trailing
    # underscore is stripped so the composed wire code doesn't end in
    # ``_`` (the prior output ``ERRORX_`` produced wire codes
    # like ``AGUI_CREWAI_FLOW_ERROR_ERRORX_`` with a trailing
    # underscore that looked ugly in alerting).
    assert _sanitize_exception_code("ErrorX\u00e9") == "ERRORX"
    # Spaces replaced.
    assert _sanitize_exception_code("Weird Exception") == "WEIRD_EXCEPTION"
    # Consecutive non-[A-Z0-9_] runs collapse to a single
    # underscore so the composed code stays greppable — prior behaviour
    # produced ``WEIRD___EXCEPTION`` for a name like "Weird---Exception".
    assert _sanitize_exception_code("Weird---Exception") == "WEIRD_EXCEPTION"
    # Leading/trailing underscores stripped.
    assert _sanitize_exception_code("_leading") == "LEADING"
    assert _sanitize_exception_code("trailing_") == "TRAILING"
    # If the cleaned result is empty or does not start with
    # [A-Z] (all-digits / all-unicode), prefix ``E_`` so the composed
    # wire code still matches ``^[A-Z][A-Z0-9_]+$``.
    assert _sanitize_exception_code("42").startswith("E_")
    assert _sanitize_exception_code("42") == "E_42"
    # All-unicode — everything sanitizes to underscores, stripped to
    # empty, then prefixed to bare ``E``.
    assert _sanitize_exception_code("\u00e9\u00e9") == "E"


def test_stamp_correlation_ids_covers_events_with_the_fields():
    """The correlation-id stamp helper must
    stamp ANY event object that declares ``thread_id`` / ``run_id``
    fields, not only the ``RUN_STARTED`` / ``RUN_FINISHED`` pair the
    pre-fix main-loop enumerated by type code. Future ag-ui.core events
    that add correlation would otherwise ship the listener's ``"?"``
    placeholders unchanged.
    """
    from ag_ui.core import RunStartedEvent, RunFinishedEvent, EventType
    from ag_ui_crewai.endpoint import _stamp_correlation_ids

    started = RunStartedEvent(
        type=EventType.RUN_STARTED, thread_id="?", run_id="?"
    )
    finished = RunFinishedEvent(
        type=EventType.RUN_FINISHED, thread_id="?", run_id="?"
    )
    _stamp_correlation_ids(started, thread_id="t-9", run_id="r-9")
    _stamp_correlation_ids(finished, thread_id="t-9", run_id="r-9")
    assert started.thread_id == "t-9"
    assert started.run_id == "r-9"
    assert finished.thread_id == "t-9"
    assert finished.run_id == "r-9"


def test_stamp_correlation_ids_noop_for_events_without_the_fields():
    """Events whose schema does not declare the fields
    (StepStartedEvent, MessagesSnapshotEvent, etc.) must be left
    UNTOUCHED — we do not add stray ``thread_id`` / ``run_id``
    attributes that would change their wire format on-write.
    """
    from ag_ui.core import StepStartedEvent, EventType
    from ag_ui_crewai.endpoint import _stamp_correlation_ids

    event = StepStartedEvent(type=EventType.STEP_STARTED, step_name="step-1")
    _stamp_correlation_ids(event, thread_id="t-9", run_id="r-9")
    # The wire form should not have sprouted correlation fields.
    dumped = event.model_dump(by_alias=True, exclude_none=True)
    assert "threadId" not in dumped and "thread_id" not in dumped
    assert "runId" not in dumped and "run_id" not in dumped
