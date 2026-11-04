"""0.x shapes kept importable for one release. Not protocol surface.

Everything here is a cushion for code written against 0.x, listed in the
repo-root DEPRECATIONS.md with its expiry. Nothing in this module describes
what travels on the wire in 1.0 — the generated models under
``ag_ui._generated`` are the only protocol source — which is why these
classes are declared here and not in ``types.py``: the spec harness guards
those modules against hand-written protocol models, and this one is
deliberately outside that guard.
"""

from typing import Literal, Optional

from pydantic import model_validator

from ag_ui._generated.models import GeneratedBaseModel


class BinaryInputContent(GeneratedBaseModel):
    """The pre-1.0 binary payload reference. Deprecated: use the media parts.

    The protocol retired the part in 1.0: ``ContentPart`` has no ``binary``
    member, and a message carrying one is rejected at ``RunAgentInput``
    validation. The class stays importable so an adapter written against 0.x
    still imports on the 1.0 SDK and its legacy branch goes quietly dead
    instead of the module failing at import. This SDK never constructs one.
    The 0.x validator (one of ``id``, ``url`` or ``data`` required) is kept so
    the class means what it meant.
    """

    type: Literal["binary"] = "binary"
    mime_type: str
    id: Optional[str] = None
    url: Optional[str] = None
    data: Optional[str] = None
    filename: Optional[str] = None

    @model_validator(mode="after")
    def validate_source(self) -> "BinaryInputContent":
        """Ensure at least one binary payload source is provided."""
        if not any([self.id, self.url, self.data]):
            raise ValueError("BinaryInputContent requires id, url, or data to be provided.")
        return self


__all__ = ["BinaryInputContent"]
