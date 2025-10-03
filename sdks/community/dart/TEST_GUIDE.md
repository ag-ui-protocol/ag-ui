# Testing Guide for AG-UI Dart SDK

## Running Tests

### Unit Tests Only (Recommended)
Run unit tests excluding integration tests that require external services:

```bash
dart test --exclude-tags requires-server
```

### All Tests
To run all tests including integration tests (requires TypeScript SDK server setup):

```bash
dart test
```

## Test Categories

### Unit Tests (381+ tests) ✅
- **SSE Components**: Parser, client, messages, backoff strategies
- **Types**: Base types, messages, tools, context
- **Encoder/Decoder**: Client codec, error handling
- **Events**: Event types, event handling
- **Client**: Configuration, error handling

### Integration Tests
These tests require the TypeScript SDK's Python server to be running:
- `simple_qa_test.dart` - Tests Q&A functionality
- `tool_generative_ui_test.dart` - Tests tool-based UI generation
- `simple_qa_docker_test.dart` - Docker-based integration tests

**Note**: Integration tests are tagged with `@Tags(['integration', 'requires-server'])` and will be skipped by default when using `--exclude-tags requires-server`.

## Test Coverage

The SDK has comprehensive unit test coverage including:
- 6 SSE client basic tests
- 8 SSE stream parsing tests
- 13 SSE message tests
- 67 base types and JSON decoder tests
- 39 error handling tests
- 59 event type tests
- 23 client configuration tests
- And many more...

## Known Limitations

1. **SSE Retry Tests**: Two tests are skipped because SSE protocol doesn't support automatic retry on HTTP errors - this is a protocol limitation, not a bug.

2. **Integration Tests**: Require TypeScript SDK infrastructure that may not be available in the Dart SDK directory structure.