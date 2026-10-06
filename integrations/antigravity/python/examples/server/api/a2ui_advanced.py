"""A2UI advanced: the dynamic-schema agent, behind the advanced dojo page.

What the advanced page adds is frontend-only: a custom progress renderer for
``render_a2ui`` calls and action handlers on the cards. The backend is the same
``generate_a2ui`` server tool as ``a2ui_dynamic_schema``.

One difference shows for this integration: ``generate_a2ui`` makes its
``render_a2ui`` call server-side, so no ``render_a2ui`` call streams to the page
and the custom progress renderer does not appear; the surface paints when the
tool's result arrives. Streaming it would take an injected ``render_a2ui``
frontend tool, which Antigravity parks until a later run answers it.
"""

from ._common import build, chat_only_capabilities
from .a2ui_dynamic_schema import SYSTEM_PROMPT, generate_a2ui

agent = build(
    capabilities=chat_only_capabilities(),
    tools=[generate_a2ui],
    system_instructions=SYSTEM_PROMPT,
)
