"""
The protocol version, and what a producer does with it.

``PROTOCOL_VERSION`` is generated, never typed by a human: it is the version
segment of the schema's ``$id`` (``https://ag-ui.com/spec/1.0/schema.json``),
so the version this SDK reports is the version its models were generated from.
Re-exported here because ``ag_ui.core`` is the package a producer imports, and
reaching into ``ag_ui._generated`` for it would be reaching past the public
surface.

Producers: the spec (``docs/spec/1.0/basic/versioning.mdx``) says an
implementation of this version MUST send its declaration, and this SDK does
not set it for you — ``RunStartedEvent`` is a generated model with
``protocol_version`` defaulting to ``None``, and giving it a non-``None``
default would make every hand-built event claim a version its producer may
not actually speak, and would fabricate one on every event parsed from a peer
that never sent it. So pass it explicitly on the event that opens a run::

    from ag_ui.core import RunStartedEvent, PROTOCOL_VERSION

    RunStartedEvent(
        thread_id=thread_id,
        run_id=run_id,
        protocol_version=PROTOCOL_VERSION,
    )

A client building a ``RunAgentInput`` declares itself the same way, through
``RunAgentInput(..., protocol_version=PROTOCOL_VERSION)``. Both fields
serialize as ``protocolVersion``.

Consumers: a declaration you cannot interpret — outside the two-component
grammar, or newer than what you speak — is handled like a newer one. Proceed,
and SHOULD warn; absent or older is a downgrade to notice quietly.
"""

from ag_ui._generated.version import PROTOCOL_VERSION

__all__ = ["PROTOCOL_VERSION"]
