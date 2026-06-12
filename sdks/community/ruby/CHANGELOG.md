# Changelog

All notable changes to the AG-UI Ruby SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-26

### Added

- Reasoning events: `ReasoningStartEvent`, `ReasoningEndEvent`, `ReasoningMessageStartEvent`, `ReasoningMessageContentEvent`, `ReasoningMessageEndEvent`, `ReasoningMessageChunkEvent`, `ReasoningEncryptedValueEvent`
- Run outcome support in `RunFinishedEvent`: `RunFinishedSuccessOutcome`, `RunFinishedInterruptOutcome`
- `reasoning` role added to `TEXT_MESSAGE_ROLE_VALUES`
- Capabilities module (`AgUiProtocol::Core::Capabilities`) with agent capability declarations:
  - `IdentityCapabilities` — agent name, type, description, version, provider, documentation URL, and metadata
  - `TransportCapabilities` — supported transports (streaming, websocket, http_binary, push_notifications, resumable)
  - `ToolsCapabilities` — tool calling support, agent-provided tools, parallel calls, client-provided tools
  - `OutputCapabilities` — structured output and supported MIME types
  - `StateCapabilities` — state snapshots, deltas, long-term memory, persistent state
  - `MultiAgentCapabilities` — multi-agent coordination, delegation, handoffs, sub-agents
  - `ReasoningCapabilities` — reasoning/thinking support, streaming, encrypted reasoning
  - `MultimodalInputCapabilities` — image, audio, video, PDF, file inputs
  - `MultimodalOutputCapabilities` — image and audio outputs
  - `MultimodalCapabilities` — combined input/output multimodal support
  - `ExecutionCapabilities` — code execution, sandboxing, iteration and time limits
  - `HumanInTheLoopCapabilities` — approvals, interventions, feedback, interrupt protocol, approve-with-edits
  - `AgentCapabilities` — categorized snapshot aggregating all of the above
  - `SubAgentInfo` — descriptor for sub-agents invoked by a parent agent

### Changed

- YARD template setup for Markdown documentation generation
- Ruby SDK documentation pages updated (overview, types, events, capabilities)

## [0.1.5] - 2026-02-11

- Update documentation and changelog URLs in the gemspec

## [0.1.4] - 2026-01-05

- Added `ag-ui-protocol.rb` alias to `ag_ui_protocol.rb` and fix tapioca rbi generation bug
- Removed redundant Sorbet type `T.nilable(T.untyped)` to fix Sorbet warnings

## [0.1.0] - 2025-12-18

### Added

- Initial release of the AG-UI Ruby SDK
- Core protocol implementation with strongly-typed models (`AgUiProtocol::Core::Types`)
- Full event type support (`AgUiProtocol::Core::Events`)
- Server-Sent Events (SSE) encoding via `AgUiProtocol::EventEncoder`
- Automatic camelCase JSON serialization and removal of `nil` values
- Runtime validation via `sorbet-runtime`
- Test suite covering types, events, and encoding

[0.2.0]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/sdk%2Fruby%2Fv0.2.0
[0.1.5]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/sdk%2Fruby%2Fv0.1.5
[0.1.4]: https://github.com/ag-ui-protocol/ag-ui/releases/tag/sdk%2Fruby%2Fv0.1.4
[0.1.0]: https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/ruby
