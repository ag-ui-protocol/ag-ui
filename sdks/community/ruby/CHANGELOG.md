# Changelog

All notable changes to the AG-UI Ruby SDK will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-12-18

### Update Gemspec (0.1.5)

- Update documentation and changelog URLs in the gemspec

### Update Gemspec (0.1.4)

- Added `ag-ui-protocol.rb` alias to `ag_ui_protocol.rb` and fix tapioca rbi generation bug
- Removed redundant Sorbet type `T.nilable(T.untyped)` to fix Sorbet warnings

### Added (0.1.0)

- Initial release of the AG-UI Ruby SDK
- Core protocol implementation with strongly-typed models (`AgUiProtocol::Core::Types`)
- Full event type support (`AgUiProtocol::Core::Events`)
- Server-Sent Events (SSE) encoding via `AgUiProtocol::EventEncoder`
- Automatic camelCase JSON serialization and removal of `nil` values
- Runtime validation via `sorbet-runtime`
- Test suite covering types, events, and encoding

[0.1.0]: https://github.com/ag-ui-protocol/ag-ui/tree/main/sdks/community/ruby
