"""Shared env-var parse helpers for ag_ui_crewai.

CR8 MEDIUM — circular import: prior to this module, ``crews.py``
imported ``_parse_env_float`` from ``endpoint.py`` via a function-local
import to sidestep the module-load cycle (``endpoint`` imports
``ChatWithCrewFlow`` from ``crews`` at the top level). The function-local
workaround is fragile — on a cold ``__pycache__`` the first-run import
can fail if both modules try to resolve each other simultaneously — and
leaks import plumbing into a hot path.

Extracting the shared helper here gives both ``endpoint`` and ``crews``
a neutral third module to import from at module load time, eliminating
the cycle entirely. This module intentionally has NO imports from
``endpoint`` or ``crews``; it must remain a leaf.
"""

import math
import os


def _parse_env_float(
    name: str,
    default: float,
    *,
    allow_disable: bool,
) -> float | None:
    """Parse a float env var with shared "non-finite / non-positive" policy.

    Consolidates the triplicated parse scaffolding previously spread
    across ``_flow_timeout_seconds`` / ``_cancel_join_timeout_seconds``
    / ``crews._llm_timeout_seconds``.

    Semantics:
    * Unset env var -> return ``default``.
    * Unparseable value (``TypeError`` / ``ValueError``) or non-finite
      (NaN / +/-inf) -> return ``default``. ``float('nan') > 0`` is
      False, which without the isfinite guard would silently flip to
      "disable" when ``allow_disable=True``.
    * ``allow_disable=True`` + non-positive value -> return ``None``
      (caller interprets as "disable the guard").
    * ``allow_disable=False`` + non-positive value -> return ``default``
      (caller requires a bounded positive; see
      ``_cancel_join_timeout_seconds`` for rationale).
    """
    raw = os.environ.get(name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    if value <= 0:
        return None if allow_disable else default
    return value
