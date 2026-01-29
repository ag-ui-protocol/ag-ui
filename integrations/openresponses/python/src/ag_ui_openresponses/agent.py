"""Main OpenResponsesAgent class."""

from __future__ import annotations

import logging
import time
import uuid
from typing import AsyncIterator

from ag_ui.core import (
    BaseEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)

from .providers import detect_provider, get_provider_defaults
from .request.request_builder import RequestBuilder
from .response.event_translator import EventTranslator
from .response.sse_parser import SSEParser
from .response.tool_call_handler import ToolCallHandler
from .types import (
    OpenResponsesAgentConfig,
    ProviderType,
)
from .utils.http_client import HttpClient

logger = logging.getLogger(__name__)


class OpenResponsesAgent:
    """AG-UI agent that connects to any OpenResponses-compatible endpoint.

    Supports OpenAI, Azure OpenAI, Hugging Face, Moltbot (formerly Clawdbot),
    and any other provider implementing the OpenResponses API.

    Examples:
        # OpenAI
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ["OPENAI_API_KEY"],
            )
        )

        # Moltbot with agent routing
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:18789",
                api_key=os.environ["MOLTBOT_TOKEN"],
                default_model="moltbot:main",
                moltbot=MoltbotProviderConfig(
                    agent_id="main",
                    session_key="user-123",
                ),
            )
        )

        # Run the agent
        async for event in agent.run(input_data):
            print(f"Event: {event}")
    """

    def __init__(self, config: OpenResponsesAgentConfig) -> None:
        """Initialize the agent with configuration.

        Args:
            config: Agent configuration including base URL, API key, and
                    provider-specific settings.
        """
        # Auto-detect provider if not specified
        provider = config.provider or detect_provider(config.base_url)
        defaults = get_provider_defaults(provider)

        # Merge defaults with provided config
        self.config = OpenResponsesAgentConfig(
            base_url=config.base_url,
            api_key=config.api_key,
            default_model=config.default_model or defaults.get("default_model"),
            headers=config.headers,
            timeout_seconds=config.timeout_seconds,
            max_retries=config.max_retries,
            provider=provider,
            moltbot=config.moltbot,
            azure=config.azure,
        )

        self._http_client = HttpClient(
            base_url=self.config.base_url,
            api_key=self.config.api_key,
            headers=self._build_headers(),
            timeout_seconds=self.config.timeout_seconds,
            max_retries=self.config.max_retries,
            api_version=self.config.azure.api_version if self.config.azure else None,
        )

        self._request_builder = RequestBuilder(self.config)

    async def run(self, input_data: RunAgentInput) -> AsyncIterator[BaseEvent]:
        """Run the agent with the given input.

        Yields AG-UI events as they are received from the OpenResponses endpoint.

        Args:
            input_data: The input containing messages, tools, and context.

        Yields:
            AG-UI events representing the agent's response.

        Raises:
            Exception: If the request fails or an error occurs during streaming.
        """
        # Build the OpenResponses request
        request = self._request_builder.build(input_data)

        # Get IDs from input
        run_id = input_data.run_id
        thread_id = input_data.thread_id

        logger.info(f"Starting run {run_id} for thread {thread_id}")

        # Emit RUN_STARTED
        yield RunStartedEvent(
            type=EventType.RUN_STARTED,
            thread_id=thread_id,
            run_id=run_id,
        )

        # Create fresh translator and tool call handler for this run
        event_translator = EventTranslator()
        tool_call_handler = ToolCallHandler()
        sse_parser = SSEParser()

        try:
            # Make streaming request
            async with self._http_client.post_stream("/responses", request) as response:
                if response.status >= 400:
                    error_text = await response.text()
                    logger.error(f"OpenResponses request failed: {response.status} {error_text}")
                    yield RunErrorEvent(
                        type=EventType.RUN_ERROR,
                        message=f"OpenResponses request failed: {response.status} {error_text}",
                    )
                    return

                # Parse SSE stream and emit AG-UI events
                async for sse_event in sse_parser.parse(response.content):
                    ag_ui_events = event_translator.translate(
                        sse_event, tool_call_handler
                    )
                    for ag_ui_event in ag_ui_events:
                        yield ag_ui_event

                    # Check for terminal events
                    if sse_event.type == "response.failed":
                        # Error already emitted by translator
                        return

                    if sse_event.type == "response.completed":
                        break

            # Emit STATE_SNAPSHOT with response_id for stateful mode
            response_id = event_translator.get_response_id()
            if response_id:
                yield event_translator.build_state_snapshot()

            # Emit RUN_FINISHED
            yield RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=thread_id,
                run_id=run_id,
            )

            logger.info(f"Completed run {run_id} for thread {thread_id}")

        except Exception as e:
            logger.error(f"Error during run {run_id}: {e}", exc_info=True)
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
            )
            raise

    def _build_headers(self) -> dict[str, str]:
        """Build request headers including provider-specific ones."""
        headers: dict[str, str] = {
            **(self.config.headers or {}),
        }

        # Moltbot-specific headers
        if self.config.moltbot:
            if self.config.moltbot.agent_id:
                headers["x-moltbot-agent-id"] = self.config.moltbot.agent_id
            if self.config.moltbot.session_key:
                headers["x-moltbot-session-key"] = self.config.moltbot.session_key

        return headers

    @staticmethod
    def _generate_id(prefix: str) -> str:
        """Generate a unique ID with the given prefix."""
        timestamp = int(time.time() * 1000)
        unique = uuid.uuid4().hex[:7]
        return f"{prefix}_{timestamp}_{unique}"
