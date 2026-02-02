"""Main OpenResponsesAgent class."""

from __future__ import annotations

import logging
import os
import time
import uuid
from typing import Any, AsyncIterator, Callable

from ag_ui.core import (
    BaseEvent,
    EventType,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
)

from .config_loader import load_config
from .providers import Provider, detect_provider, get_provider
from .request.request_builder import RequestBuilder
from .response.event_translator import EventTranslator
from .response.sse_parser import SSEParser
from .response.tool_call_handler import ToolCallHandler
from .types import (
    OpenResponsesAgentConfig,
    ProviderType,
    fill_runtime_config,
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

    def __init__(
        self,
        config: OpenResponsesAgentConfig | None = None,
        restrict_configs: bool = False,
        config_dir: str | None = None,
        user_id: str | None = None,
        user_id_extractor: Callable[[RunAgentInput], str | None] | None = None,
    ) -> None:
        """Initialize the agent with configuration.

        Args:
            config: Agent configuration. All fields are optional — missing
                    values can be supplied at runtime via
                    ``forwarded_props.openresponses_config``.
            restrict_configs: When True, a named config is required for every
                run and caller-supplied runtime overrides can only fill gaps
                (fields left at their default) rather than override values
                set by the named config.
            config_dir: Directory containing named JSON config files.
                Defaults to ``$OPENRESPONSES_CONFIG_DIR`` or ``./configs``.
            user_id: Static user identifier sent in the ``user`` field of
                OpenResponses requests. Mutually exclusive with
                *user_id_extractor*.
            user_id_extractor: Callable that receives the ``RunAgentInput``
                and returns a user identifier (or None). Mutually exclusive
                with *user_id*.
        """
        if user_id is not None and user_id_extractor is not None:
            raise ValueError(
                "user_id and user_id_extractor are mutually exclusive. "
                "Provide one or the other, not both."
            )

        self._static_config = config or OpenResponsesAgentConfig()
        self._restrict_configs = restrict_configs
        self._config_dir = config_dir
        self._user_id = user_id
        self._user_id_extractor = user_id_extractor

        # If base_url is already known we can eagerly create the client
        if self._static_config.base_url:
            resolved = self._apply_provider_defaults(self._static_config)
            self._provider = self._resolve_provider(resolved)
            self._http_client: HttpClient | None = self._create_http_client(resolved)
            self._request_builder: RequestBuilder | None = RequestBuilder(resolved, self._provider)
            self.config = resolved
        else:
            self._provider = Provider()
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

        # Resolve user_id and build the OpenResponses request
        user = self._resolve_user_id(input_data)
        request = request_builder.build(input_data, user=user)

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

    def _resolve_user_id(self, input_data: RunAgentInput) -> str | None:
        """Resolve the ``user`` value for the OpenResponses request.

        Resolution order (highest priority wins):
        1. ``user_id_extractor(input_data)`` — operator callback
        2. Static ``user_id`` from __init__
        3. Provider-specific default (e.g. OpenClaw → ``$USER`` / ``"user"``)
        4. Otherwise: ``None`` (no ``user`` field sent)
        """
        if self._user_id_extractor is not None:
            return self._user_id_extractor(input_data)
        if self._user_id is not None:
            return self._user_id
        return self._provider.default_user_id(input_data)

    def _resolve_provider(self, config: OpenResponsesAgentConfig) -> Provider:
        """Return the Provider instance for a resolved config."""
        provider_type = config.provider or ProviderType.CUSTOM
        return get_provider(provider_type)

    def _resolve_run_config(
        self, input_data: RunAgentInput, config_name: str | None = None,
    ) -> tuple[HttpClient, RequestBuilder]:
        """Resolve effective config for this run.

        Priority (highest wins):
        1. ``forwarded_props.openresponses_config`` (per-request overrides)
        2. Named JSON config (from *config_name* or
           ``forwarded_props.config_name``)
        3. Static config from ``__init__``

        Returns:
            Tuple of (http_client, request_builder) ready for this run.

        Raises:
            ValueError: If the effective config is missing ``base_url``.
        """
        runtime_dict: dict[str, Any] | None = None
        fp_config_name: str | None = config_name
        if input_data.forwarded_props:
            runtime_dict = input_data.forwarded_props.get("openresponses_config")
            if not fp_config_name:
                fp_config_name = input_data.forwarded_props.get("config_name")

        # When restrict_configs is enabled, a named config is mandatory
        if self._restrict_configs and not fp_config_name:
            raise ValueError(
                "A named config is required when restrict_configs is enabled. "
                "Provide a config_name via the URL path or forwarded_props."
            )

        # Layer 1: start with static config
        base = self._static_config

        # Layer 2: merge named JSON config underneath runtime overrides
        if fp_config_name:
            try:
                named_cfg = load_config(fp_config_name, config_dir=self._config_dir)
            except FileNotFoundError as exc:
                raise ValueError(str(exc)) from exc
            base = merge_runtime_config(base, named_cfg)

        if not runtime_dict and not fp_config_name:
            # No runtime overrides or named config — use pre-built client
            if self._http_client and self._request_builder:
                return self._http_client, self._request_builder
            if not self._static_config.base_url:
                raise ValueError(
                    "OpenResponsesAgent requires a base_url. Provide it in the "
                    "static config or via forwarded_props.openresponses_config."
                )
            resolved = self._apply_provider_defaults(self._static_config)
            self._provider = self._resolve_provider(resolved)
            return self._create_http_client(resolved), RequestBuilder(resolved, self._provider)

        # Layer 3: merge runtime overrides on top
        if runtime_dict:
            if self._restrict_configs:
                base = fill_runtime_config(base, runtime_dict)
            else:
                base = merge_runtime_config(base, runtime_dict)

        if not base.base_url:
            raise ValueError(
                "OpenResponsesAgent requires a base_url. Provide it in the "
                "static config or via forwarded_props.openresponses_config."
            )

        resolved = self._apply_provider_defaults(base)
        self._provider = self._resolve_provider(resolved)
        return self._create_http_client(resolved), RequestBuilder(resolved, self._provider)

    def _apply_provider_defaults(
        self, config: OpenResponsesAgentConfig
    ) -> OpenResponsesAgentConfig:
        """Apply provider detection and defaults to a config."""
        provider = config.provider or (
            detect_provider(config.base_url) if config.base_url else ProviderType.CUSTOM
        )
        provider_obj = get_provider(provider)

        return OpenResponsesAgentConfig(
            base_url=config.base_url,
            api_key=config.api_key,
            default_model=config.default_model or provider_obj.default_model,
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
            headers=self._provider.build_headers(config),
            timeout_seconds=config.timeout_seconds,
            max_retries=config.max_retries,
            api_version=config.azure.api_version if config.azure else None,
        )

    def _build_headers(self, config: OpenResponsesAgentConfig | None = None) -> dict[str, str]:
        """Build request headers including provider-specific ones."""
        cfg = config or self.config
        return self._provider.build_headers(cfg)

    @staticmethod
    def _generate_id(prefix: str) -> str:
        """Generate a unique ID with the given prefix."""
        timestamp = int(time.time() * 1000)
        unique = uuid.uuid4().hex[:7]
        return f"{prefix}_{timestamp}_{unique}"
