"""Test-local stand-in for Strands' interrupt state.

The adapter never imports Strands' interrupt-state class. It reads the state
structurally off the agent (``activated``, ``interrupts``, ``context`` and the
parked tool batch), so a test that needs a paused agent only needs an object
exposing that surface.

Importing the real private class instead pins the suite to one Strands
release: it moved from ``strands.agent.interrupt.InterruptState`` to
``strands.interrupt._InterruptState``, and ``activate`` went from taking a
context (which it overwrote) to taking none. Neither difference is visible to
the adapter, so neither belongs in the tests.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class PendingToolExecutionStub:
    """The typed parked-tool-batch field Strands grew in 1.55.

    Before it, a checkpoint kept the batch it stopped inside on ``context``
    under ``"tool_use_message"`` and ``"tool_results"``; from 1.55 it keeps the
    same two things here and migrates the legacy keys out of ``context`` on
    load. The adapter reads whichever shape the installed release writes, so
    the suite has to be able to build both on any release, which is why this is
    a local paraphrase rather than an import.
    """

    assistant_message: Any = None
    completed_tool_results: list[Any] = field(default_factory=list)


@dataclass
class InterruptStateStub:
    """The interrupt-state surface the adapter observes."""

    interrupts: dict[str, Any] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    activated: bool = False
    pending_tool_execution: PendingToolExecutionStub | None = None
    _version: int = field(default=0, compare=False, repr=False)

    def activate(self, context: dict[str, Any] | None = None) -> None:
        """Mark the state paused, replacing the context only when one is given."""
        if context is not None:
            self.context = context
        self.activated = True

    def resume(self, prompt: Any) -> None:
        """Record the submitted answers on their interrupts, as Strands does.

        Paraphrased rather than delegated for the reason given above: the real
        method is on a private class that moved between releases, and the oldest
        release this package supports has no ``resume`` at all, so calling it
        would pin the suite. ``test_stub_resume_matches_the_installed_sdk``
        holds the paraphrase to the installed release's behaviour.
        """
        if not self.activated:
            return
        if not isinstance(prompt, list):
            raise TypeError(
                f"prompt_type={type(prompt)} | must resume from interrupt with "
                "list of interruptResponse's"
            )
        foreign_types = [
            content_type
            for content in prompt
            for content_type in content
            if content_type != "interruptResponse"
        ]
        if foreign_types:
            raise TypeError(
                f"content_types=<{foreign_types}> | must resume from interrupt "
                "with list of interruptResponse's"
            )
        for content in prompt:
            interrupt_id = content["interruptResponse"]["interruptId"]
            if interrupt_id not in self.interrupts:
                raise KeyError(f"interrupt_id=<{interrupt_id}> | no interrupt found")
            self.interrupts[interrupt_id].response = content["interruptResponse"][
                "response"
            ]
        self.context["responses"] = prompt

    def set_pending_tool_results(self, completed_tool_results: list[Any]) -> None:
        """Replace the parked results and bump the version, as Strands does.

        The bump is the load-bearing half. ``RepositorySessionManager`` only
        writes interrupt state back when this counter has moved, so a result
        corrected in place but never published through here reaches the run in
        flight and nothing after it.
        """
        if self.pending_tool_execution is None:
            return
        self.pending_tool_execution.completed_tool_results = completed_tool_results
        self._version += 1

    def deactivate(self) -> None:
        """Clear the pause, dropping interrupts and context as Strands does."""
        self.interrupts = {}
        self.context = {}
        self.activated = False
        self.pending_tool_execution = None
        self._version += 1

    def to_dict(self) -> dict[str, Any]:
        """Serialize the way Strands does, so checkpoint snapshots compare."""
        return {
            "interrupts": {key: itr.to_dict() for key, itr in self.interrupts.items()},
            "context": self.context,
            "activated": self.activated,
        }
