"""HTTP client with streaming support for OpenResponses API."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

import aiohttp

logger = logging.getLogger(__name__)


class HttpClient:
    """HTTP client with streaming support for OpenResponses API."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        headers: dict[str, str] | None = None,
        timeout_seconds: float = 120.0,
        max_retries: int = 3,
        api_version: str | None = None,
    ) -> None:
        """Initialize the HTTP client.

        Args:
            base_url: Base URL for requests.
            api_key: API key for authentication.
            headers: Additional headers to include.
            timeout_seconds: Request timeout in seconds.
            max_retries: Maximum retry attempts.
            api_version: API version (for Azure).
        """
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._custom_headers = headers or {}
        self._timeout = aiohttp.ClientTimeout(total=timeout_seconds)
        self._max_retries = max_retries
        self._api_version = api_version

    @asynccontextmanager
    async def post_stream(
        self, path: str, body: dict[str, Any]
    ) -> AsyncIterator[aiohttp.ClientResponse]:
        """Make a streaming POST request.

        Args:
            path: Request path (e.g., "/responses").
            body: Request body as dictionary.

        Yields:
            The aiohttp response object.

        Raises:
            aiohttp.ClientError: On network errors after retries.
            Exception: On other failures.
        """
        url = self._build_url(path)
        headers = self._build_headers()

        last_error: Exception | None = None

        for attempt in range(self._max_retries + 1):
            try:
                async with aiohttp.ClientSession(timeout=self._timeout) as session:
                    async with session.post(
                        url,
                        json=body,
                        headers=headers,
                    ) as response:
                        # Don't retry on client errors (4xx)
                        if 400 <= response.status < 500:
                            yield response
                            return

                        # Retry on server errors (5xx)
                        if response.status >= 500 and attempt < self._max_retries:
                            last_error = Exception(f"Server error: {response.status}")
                            wait_time = 2**attempt
                            logger.warning(
                                f"Server error {response.status}, retrying in {wait_time}s "
                                f"(attempt {attempt + 1}/{self._max_retries + 1})"
                            )
                            await asyncio.sleep(wait_time)
                            continue

                        yield response
                        return

            except (aiohttp.ClientError, asyncio.TimeoutError) as e:
                last_error = e
                if attempt < self._max_retries:
                    wait_time = 2**attempt
                    logger.warning(
                        f"Request error: {e}, retrying in {wait_time}s "
                        f"(attempt {attempt + 1}/{self._max_retries + 1})"
                    )
                    await asyncio.sleep(wait_time)
                    continue

        if last_error:
            raise last_error
        raise Exception("Request failed after retries")

    def _build_url(self, path: str) -> str:
        """Build the full URL for a request.

        Args:
            path: Request path.

        Returns:
            Full URL string.
        """
        # Normalize the path
        clean_path = path if path.startswith("/") else f"/{path}"

        # Check if base_url already ends with /v1
        if self._base_url.endswith("/v1"):
            url = f"{self._base_url}{clean_path}"
        else:
            url = f"{self._base_url}/v1{clean_path}"

        # Azure requires api-version query param
        if self._api_version:
            separator = "&" if "?" in url else "?"
            url += f"{separator}api-version={self._api_version}"

        return url

    def _build_headers(self) -> dict[str, str]:
        """Build request headers.

        Returns:
            Dictionary of headers.
        """
        headers = {
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            **self._custom_headers,
        }

        # Azure uses different auth header
        if self._api_version:
            headers["api-key"] = self._api_key
        else:
            headers["Authorization"] = f"Bearer {self._api_key}"

        return headers
