# AG-UI Ruby Example: Rails

This example demonstrates how to expose a minimal AG-UI compatible endpoint in **Rails (Puma)** using **Server-Sent Events (SSE)**.

The `POST /` endpoint streams the following events (same sequence as the Python example):

- `RunStartedEvent`
- `TextMessageStartEvent`
- `TextMessageContentEvent`
- `TextMessageEndEvent`
- `RunFinishedEvent`

## Prerequisites

- **Ruby**: Version 3.0 or higher

```bash
# Check your Ruby version
ruby --version
```

- **Bundle**: Version 2.5.14 or higher

```bash
# Check your Bundle version
bundle --version
```

## Setup

### 1. Clone the Repository

```bash
# Clone the AG-UI repository
git clone https://github.com/ag-ui-protocol/ag-ui.git
cd ag-ui
```

### 2. Install Dependencies

```bash
# Navigate to the Rails example directory
cd sdks/community/ruby/example/rails
# Install dependencies
bundle install
```

## Running the Example

1. Start the Rails server (Puma)

    ```bash
    bundle exec puma -C config/puma.rb config.ru
    ```

2. In other terminal, Test the endpoint with curl

    ```bash
    curl -N \
      -H 'Accept: text/event-stream' \
      -H 'Content-Type: application/json' \
      -d '{"thread_id":"thread_123","run_id":"run_123"}' \
      http://localhost:3000/
    ```

It also works with an empty body (the server will generate `thread_id`/`run_id`):

```bash
curl -N -H 'Accept: text/event-stream' -H 'Content-Type: application/json' -d '{}' http://localhost:3000/
```

## Alternative with ActionController::Live (Conceptual Overview)

You can also use `ActionController::Live` directly to stream events instead of `with_stream`. This example uses `with_stream` for simplicity and to align with Rails 7.1.

This section describes how you could implement the same SSE-compatible AG-UI endpoint using `ActionController::Live` directly. The core ideas:

1. **Include the module**  
   In your controller, include `ActionController::Live` to enable streaming responses.

2. **Set SSE headers**  
   Configure the response headers for a Server-Sent Events stream:
   - `Content-Type: text/event-stream`
   - `Cache-Control: no-cache`
   - `Connection: keep-alive`

3. **Use `response.stream`**  
   Write encoded AG-UI events to `response.stream` inside a `begin`/`ensure` block, making sure to:
   - Encode each event with `AgUiProtocol::Encoder::EventEncoder`
   - Flush after each write if needed (`response.stream.write(...)`)
   - Always close the stream in `ensure` with `response.stream.close`

4. **Handle exceptions and client disconnects**  
   Be prepared for:
   - `IOError` when the client disconnects
   - General exceptions for logging / cleanup
   - Ensuring no further writes occur after an error

5. **Lifecycle of events**  
   Emit events in the same order as other examples (e.g. `RunStarted`, text content events, `RunFinished`). Conceptually, the controller action:
   - Parses the request body (thread/run IDs, etc.)
   - Creates the appropriate AG-UI events
   - Streams them one by one to the client as SSE

This approach gives you fine-grained control over the streaming behavior while remaining fully compatible with AG-UI protocol clients.
