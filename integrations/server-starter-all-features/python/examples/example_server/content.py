"""
Reading message content the AG-UI 1.0 way.

In AG-UI 1.0 a message's ``content`` is either a plain string or a list of
content parts (``TextPart`` plus the media parts: image, audio, video,
document). A producer must accept both shapes rather than assume a string.
See https://docs.ag-ui.com/migrating-to-1-0#producers-declare-your-version
"""

import logging
from typing import Optional

from ag_ui.core import TextPart

logger = logging.getLogger(__name__)


def message_text(message) -> Optional[str]:
    """Return the text of a message's content, or ``None`` if it has none.

    A string is returned as is. For a list of content parts, the text parts
    are joined with newlines; media parts are skipped with a warning, because
    these examples only act on text.
    """
    content = getattr(message, "content", None)
    if content is None or isinstance(content, str):
        return content

    texts = []
    for part in content:
        if isinstance(part, TextPart):
            texts.append(part.text)
        else:
            logger.warning(
                "Skipping %s content part: this example only handles text",
                getattr(part, "type", type(part).__name__),
            )
    return "\n".join(texts)
