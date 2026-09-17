"""
The two protocol version constants, and what a producer does with them.

``WIRE_PROTOCOL_VERSION`` is the protocol LINE this SDK speaks. It is
hand-written, and deliberately NOT the generated ``PROTOCOL_VERSION``: the
wire names what an implementation speaks, while the generated constant names
which spec revision the models were emitted from (currently ``"draft"``, the
version segment of the schema's ``$id``). They are also not interchangeable
as values — the versioning rules compare declarations as two numeric
components, which ``"draft"`` can never satisfy, so a producer declaring it
would be read by every consumer as uninterpretable. At the 1.0 freeze, when
the schema ``$id`` moves to ``/spec/1.0/``, the two constants collapse into
the same string and this one can go away.

The same name, value and reasoning as TypeScript's
``WIRE_PROTOCOL_VERSION`` in
``sdks/typescript/packages/client/src/agent/agent.ts``; the two must stay in
step.

Producers: the spec (``docs/spec/draft/basic/versioning.mdx``) says an
implementation of this version MUST send its declaration, and this SDK does
not set it for you — ``RunStartedEvent`` is a generated model with
``protocol_version`` defaulting to ``None``, and giving it a non-``None``
default would make every hand-built event claim a version its producer may
not actually speak. So pass it explicitly on the event that opens a run::

    from ag_ui.core import RunStartedEvent, WIRE_PROTOCOL_VERSION

    RunStartedEvent(
        thread_id=thread_id,
        run_id=run_id,
        protocol_version=WIRE_PROTOCOL_VERSION,
    )

A client building a ``RunAgentInput`` declares itself the same way, through
``RunAgentInput(..., protocol_version=WIRE_PROTOCOL_VERSION)``. Both fields
serialize as ``protocolVersion``.

Consumers: a declaration you cannot interpret — outside the two-component
grammar, or newer than what you speak — is handled like a newer one. Proceed,
and SHOULD warn; absent or older is a downgrade to notice quietly.
"""

from ag_ui._generated.version import PROTOCOL_VERSION

WIRE_PROTOCOL_VERSION = "1.0"
"""
The protocol version this SDK declares on the wire: ``RUN_STARTED``'s
``protocolVersion`` for a producer, ``RunAgentInput``'s for a client.

See this module's docstring for why it is not ``PROTOCOL_VERSION``.
"""

__all__ = ["WIRE_PROTOCOL_VERSION", "PROTOCOL_VERSION"]
