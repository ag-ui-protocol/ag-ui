"""Parses Server-Sent Events from OpenResponses streams."""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from aiohttp import StreamReader

from ..types import OpenResponsesSSEEvent

logger = logging.getLogger(__name__)


class SSEParser:
    """Parses Server-Sent Events from an OpenResponses stream."""

    async def parse(
        self, stream: StreamReader
    ) -> AsyncIterator[OpenResponsesSSEEvent]:
        """Parse SSE events from an aiohttp StreamReader.

        Args:
            stream: The response content stream.

        Yields:
            Parsed OpenResponses events.
        """
        buffer = ""
        event_type: str | None = None
        event_data: list[str] = []

        async for chunk in stream.iter_any():
            buffer += chunk.decode("utf-8")

            # Process complete lines in buffer
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.rstrip("\r")

                if line.startswith("event:"):
                    event_type = line[6:].strip()

                elif line.startswith("data:"):
                    data = line[5:].strip()
                    if data == "[DONE]":
                        logger.debug("Received [DONE] signal")
                        return
                    event_data.append(data)

                elif line == "":
                    # Empty line signals end of event
                    if event_data:
                        try:
                            data_str = "\n".join(event_data)
                            parsed = json.loads(data_str) if data_str else {}
                            # Use explicit event: field if present,
                            # otherwise extract type from JSON payload
                            resolved_type = event_type or parsed.get("type")
                            if resolved_type:
                                logger.debug(f"Parsed SSE event: {resolved_type}")
                                yield OpenResponsesSSEEvent(
                                    type=resolved_type,
                                    data=parsed,
                                )
                        except json.JSONDecodeError as e:
                            logger.warning(
                                f"Failed to parse SSE event data: {e}"
                            )

                    event_type = None
                    event_data = []

        # Handle any remaining data in buffer (shouldn't happen with proper SSE)
        if event_data:
            try:
                data_str = "\n".join(event_data)
                parsed = json.loads(data_str) if data_str else {}
                resolved_type = event_type or parsed.get("type")
                if resolved_type:
                    yield OpenResponsesSSEEvent(
                        type=resolved_type,
                        data=parsed,
                    )
            except json.JSONDecodeError:
                pass
