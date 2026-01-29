# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **NEW**: Initial implementation of OpenResponses AG-UI integration
  - `OpenResponsesAgent` class that connects to any OpenResponses-compatible endpoint
  - Provider auto-detection for OpenAI, Azure OpenAI, Hugging Face, and Moltbot from base URL
  - SSE stream parsing and translation of OpenResponses events to AG-UI protocol events
  - Stateful conversation support via `previous_response_id` passthrough in `openresponses_state`
  - Client-side tool call execution with proper AG-UI event sequencing (TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END)
  - Multimodal content support (images, files) via AG-UI `BinaryInputContent`
  - `create_openresponses_endpoint()` FastAPI endpoint factory for easy server setup
  - Configurable provider settings including Azure-specific and Moltbot-specific options
  - Uses OpenAI SDK types (`FunctionToolParam`, `ResponseCreateParams`) to avoid type duplication
  - Error handling with `RUN_ERROR` event emission on failures
  - aiohttp-based HTTP client with retry support
- **NEW**: Dojo app integration with `HttpAgent` configuration
- **NEW**: Example server demonstrating agentic chat feature
- **NEW**: Integration tests against OpenAI Responses API

### Dependencies

- ag-ui-protocol >= 0.1.10
- aiohttp >= 3.9.0
- fastapi >= 0.115.0
- openai >= 1.60.0
- pydantic >= 2.0.0
