"""A2UI error recovery: the dynamic-schema tool, with its retry loop in view.

The same backend-owned ``generate_a2ui`` server tool as ``a2ui_dynamic_schema``.
It validates each ``render_a2ui`` attempt and retries with the validation
errors appended to the sub-agent prompt, up to ``MAX_ATTEMPTS``. A faulty
attempt never reaches the client. When every attempt fails, the tool returns
the toolkit's ``a2ui_recovery_exhausted`` envelope, which the runtime's A2UI
middleware turns into the "Couldn't generate the UI" card, and the chat stays
usable.

The loop runs inside the tool, so the client sees one tool call and its final
result: the page's "Retrying..." status, which the middleware derives from
streamed ``render_a2ui`` calls, does not appear for this integration.
"""

from ._common import build, chat_only_capabilities
from .a2ui_dynamic_schema import MAX_ATTEMPTS, generate_a2ui

__all__ = ["MAX_ATTEMPTS", "agent"]

agent = build(
    capabilities=chat_only_capabilities(),
    tools=[generate_a2ui],
    system_instructions=(
        "You are a helpful assistant that creates rich visual UI on the fly.\n"
        "- For any request for visual content, call generate_a2ui exactly "
        "once, passing the request verbatim. It validates what it draws and "
        "repairs a faulty attempt itself.\n"
        "- Afterwards, reply with one short sentence and stop; do not repeat "
        "the data.\n"
        "- If it reports that it could not generate the UI, say so in one "
        "sentence; do not call it again."
    ),
)
