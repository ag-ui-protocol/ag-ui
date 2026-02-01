"""Main OpenResponsesAgent class."""

from __future__ import annotations

import logging
import time
import uuid
from typing import Any, AsyncIterator

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
    merge_runtime_config,
)
from .utils.http_client import HttpClient

logger = logging.getLogger(__name__)


class OpenResponsesAgent:
    """AG-UI agent that connects to any OpenResponses-compatible endpoint.

    Supports OpenAI, Azure OpenAI, Hugging Face, OpenClaw,
    and any other provider implementing the OpenResponses API.

    Examples:
        # OpenAI
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="https://api.openai.com/v1",
                api_key=os.environ["OPENAI_API_KEY"],
            )
        )

        # OpenClaw with agent routing
        agent = OpenResponsesAgent(
            OpenResponsesAgentConfig(
                base_url="http://localhost:18789",
                api_key=os.environ["OPENCLAW_TOKEN"],
                default_model="openclaw:main",
                openclaw=OpenClawProviderConfig(
                    agent_id="main",
                    session_key="user-123",
                ),
            )
        )

        # Run the agent
        async for event in agent.run(input_data):
            print(f"Event: {event}")
    """

    def __init__(self, config: OpenResponsesAgentConfig | None = None) -> None:
        """Initialize the agent with configuration.

        Args:
            config: Agent configuration. All fields are optional — missing
                    values can be supplied at runtime via
                    ``forwarded_props.openresponses_config``.
        """
        self._static_config = config or OpenResponsesAgentConfig()

        # If base_url is already known we can eagerly create the client
        if self._static_config.base_url:
            resolved = self._apply_provider_defaults(self._static_config)
            self._http_client: HttpClient | None = self._create_http_client(resolved)
            self._request_builder: RequestBuilder | None = RequestBuilder(resolved)
            self.config = resolved
        else:
            self._http_client = None
            self._request_builder = None
            self.config = self._static_config

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
        # Resolve config (static + runtime merge) and validate
        try:
            http_client, request_builder = self._resolve_run_config(input_data)
        except ValueError as e:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message=str(e),
            )
            return

        # Build the OpenResponses request
        request = request_builder.build(input_data)

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
            async with http_client.post_stream("/responses", request) as response:
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

    def _resolve_run_config(
        self, input_data: RunAgentInput
    ) -> tuple[HttpClient, RequestBuilder]:
        """Resolve effective config for this run.

        Merges any runtime overrides from
        ``forwarded_props.openresponses_config`` into the static config.

        Returns:
            Tuple of (http_client, request_builder) ready for this run.

        Raises:
            ValueError: If the effective config is missing ``base_url``.
        """
        runtime_dict: dict[str, Any] | None = None
        if input_data.forwarded_props:
            runtime_dict = input_data.forwarded_props.get("openresponses_config")

        if not runtime_dict:
            # No runtime overrides — use pre-built client if available
            if self._http_client and self._request_builder:
                return self._http_client, self._request_builder
            # Static config is incomplete and no runtime supplement
            if not self._static_config.base_url:
                raise ValueError(
                    "OpenResponsesAgent requires a base_url. Provide it in the "
                    "static config or via forwarded_props.openresponses_config."
                )
            # Shouldn't reach here, but handle gracefully
            resolved = self._apply_provider_defaults(self._static_config)
            return self._create_http_client(resolved), RequestBuilder(resolved)

        # Merge runtime overrides into static config
        merged = merge_runtime_config(self._static_config, runtime_dict)

        if not merged.base_url:
            raise ValueError(
                "OpenResponsesAgent requires a base_url. Provide it in the "
                "static config or via forwarded_props.openresponses_config."
            )

        resolved = self._apply_provider_defaults(merged)
        return self._create_http_client(resolved), RequestBuilder(resolved)

    def _apply_provider_defaults(
        self, config: OpenResponsesAgentConfig
    ) -> OpenResponsesAgentConfig:
        """Apply provider detection and defaults to a config."""
        provider = config.provider or (
            detect_provider(config.base_url) if config.base_url else ProviderType.CUSTOM
        )
        defaults = get_provider_defaults(provider)

        return OpenResponsesAgentConfig(
            base_url=config.base_url,
            api_key=config.api_key,
            default_model=config.default_model or defaults.get("default_model"),
            headers=config.headers,
            timeout_seconds=config.timeout_seconds,
            max_retries=config.max_retries,
            provider=provider,
            openclaw=config.openclaw,
            azure=config.azure,
        )

    def _create_http_client(self, config: OpenResponsesAgentConfig) -> HttpClient:
        """Create an HttpClient from a resolved config."""
        return HttpClient(
            base_url=config.base_url,  # type: ignore[arg-type]
            api_key=config.api_key,
            headers=self._build_headers(config),
            timeout_seconds=config.timeout_seconds,
            max_retries=config.max_retries,
            api_version=config.azure.api_version if config.azure else None,
        )

    def _build_headers(self, config: OpenResponsesAgentConfig | None = None) -> dict[str, str]:
        """Build request headers including provider-specific ones."""
        cfg = config or self.config
        headers: dict[str, str] = {
            **(cfg.headers or {}),
        }

        # OpenClaw-specific headers
        if cfg.openclaw:
            if cfg.openclaw.agent_id:
                headers["x-openclaw-agent-id"] = cfg.openclaw.agent_id
            if cfg.openclaw.session_key:
                headers["x-openclaw-session-key"] = cfg.openclaw.session_key

        return headers

    @staticmethod
    def _generate_id(prefix: str) -> str:
        """Generate a unique ID with the given prefix."""
        timestamp = int(time.time() * 1000)
        unique = uuid.uuid4().hex[:7]
        return f"{prefix}_{timestamp}_{unique}"
