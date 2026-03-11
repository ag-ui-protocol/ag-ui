---
name: agui-event-encoding
description: >
  Encode and decode AG-UI events for transport. EventEncoder with Accept header
  negotiation. SSE text encoding (recommended default) and protobuf binary encoding
  via @ag-ui/proto. Content-Type handling with encoder.get_content_type().
type: core
library: ag-ui
library_version: "0.0.47"
sources:
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/encoder/src
  - ag-ui-protocol/ag-ui:sdks/typescript/packages/proto/src
  - ag-ui-protocol/ag-ui:docs/quickstart/server.mdx
---

# AG-UI -- Event Encoding

## Setup

Install the encoder package (and proto if you need binary encoding):

```bash
pnpm add @ag-ui/encoder
# @ag-ui/proto is a transitive dependency of @ag-ui/encoder, no separate install needed
```

Minimum working example -- SSE server endpoint (TypeScript, Express-style):

```typescript
import { EventEncoder } from "@ag-ui/encoder";
import { EventType } from "@ag-ui/core";
import type { BaseEvent, RunStartedEvent, RunFinishedEvent, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent } from "@ag-ui/core";

// Create encoder from the client's Accept header
const encoder = new EventEncoder({ accept: req.headers.accept });

// Set the response Content-Type to match the encoder's output format
res.setHeader("Content-Type", encoder.getContentType());

// Encode individual events -- returns SSE-formatted string by default
const sseChunk: string = encoder.encode({
  type: EventType.RUN_STARTED,
  threadId: "thread-1",
  runId: "run-1",
} as RunStartedEvent);

// sseChunk is: 'data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}\n\n'
res.write(sseChunk);
```

## Core Patterns

### Pattern 1: SSE text encoding (recommended default)

SSE is the default encoding. When the Accept header is `text/event-stream`, absent,
or does not include the protobuf media type, `EventEncoder` uses SSE.

```typescript
import { EventEncoder } from "@ag-ui/encoder";
import { EventType } from "@ag-ui/core";
import type { RunStartedEvent, TextMessageStartEvent, TextMessageContentEvent, TextMessageEndEvent, RunFinishedEvent } from "@ag-ui/core";

// No accept header or accept: "text/event-stream" both produce SSE
const encoder = new EventEncoder(); // defaults to SSE
// equivalent: new EventEncoder({ accept: "text/event-stream" })

console.log(encoder.getContentType()); // "text/event-stream"

// encode() always returns an SSE string: 'data: <JSON>\n\n'
const chunk = encoder.encode({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "msg-1",
  delta: "Hello",
});
// chunk === 'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello"}\n\n'
```

Full streaming endpoint with Express:

```typescript
import { EventEncoder } from "@ag-ui/encoder";
import { EventType } from "@ag-ui/core";
import type { Request, Response } from "express";

function handleAgentRequest(req: Request, res: Response) {
  const encoder = new EventEncoder({ accept: req.headers.accept });

  res.setHeader("Content-Type", encoder.getContentType());
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const { threadId, runId } = req.body;

  res.write(encoder.encode({ type: EventType.RUN_STARTED, threadId, runId }));
  res.write(encoder.encode({ type: EventType.TEXT_MESSAGE_START, messageId: "m1", role: "assistant" }));
  res.write(encoder.encode({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Hello world" }));
  res.write(encoder.encode({ type: EventType.TEXT_MESSAGE_END, messageId: "m1" }));
  res.write(encoder.encode({ type: EventType.RUN_FINISHED, threadId, runId }));
  res.end();
}
```

### Pattern 2: Protobuf binary encoding

When the client sends `Accept: application/vnd.ag-ui.event+proto`, the encoder
switches to binary protobuf output. This is useful for bandwidth-constrained
environments but SSE is recommended for most use cases.

```typescript
import { EventEncoder, AGUI_MEDIA_TYPE } from "@ag-ui/encoder";
import { EventType } from "@ag-ui/core";

// Client sends Accept header that includes the proto media type
const encoder = new EventEncoder({
  accept: `text/event-stream, ${AGUI_MEDIA_TYPE}`,
});

console.log(encoder.getContentType()); // "application/vnd.ag-ui.event+proto"

// encodeBinary() returns Uint8Array -- protobuf when accepted, SSE bytes otherwise
const binary: Uint8Array = encoder.encodeBinary({
  type: EventType.TEXT_MESSAGE_START,
  messageId: "msg-1",
  role: "assistant",
});
// binary is a length-prefixed protobuf message:
// [4 bytes: uint32 big-endian message length][N bytes: protobuf payload]
```

The protobuf wire format uses a 4-byte big-endian uint32 length prefix followed
by the protobuf-encoded message. To decode on the client side:

```typescript
import { decode } from "@ag-ui/proto";

// Given a Uint8Array `data` from the binary stream:
const dataView = new DataView(data.buffer);
const messageLength = dataView.getUint32(0, false); // big-endian
const messageBytes = data.slice(4, 4 + messageLength);
const event = decode(messageBytes);
// event is a fully validated BaseEvent with correct types
```

### Pattern 3: Content negotiation on the server

The encoder reads the Accept header and selects the best encoding. The server
must set the response Content-Type to match.

```typescript
import { EventEncoder } from "@ag-ui/encoder";

function createStreamingResponse(acceptHeader: string | undefined) {
  const encoder = new EventEncoder({ accept: acceptHeader });

  // getContentType() returns either "text/event-stream" or "application/vnd.ag-ui.event+proto"
  const contentType = encoder.getContentType();

  // Use this as the response Content-Type header
  return { encoder, contentType };
}
```

Negotiation rules:
- No Accept header: defaults to SSE (`text/event-stream`)
- `Accept: text/event-stream`: SSE
- `Accept: application/vnd.ag-ui.event+proto`: protobuf binary
- `Accept: text/event-stream, application/vnd.ag-ui.event+proto`: protobuf binary (higher specificity)
- `Accept: */*`: SSE (protobuf is not matched by wildcard since it requires explicit opt-in)

### Pattern 4: Python server with EventEncoder (FastAPI)

The Python SDK provides the same EventEncoder API. This is the pattern shown
in the official quickstart guide.

```python
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from ag_ui.core import (
    RunAgentInput,
    EventType,
    RunStartedEvent,
    RunFinishedEvent,
    TextMessageStartEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
)
from ag_ui.encoder import EventEncoder
import uuid

app = FastAPI()

@app.post("/")
async def agent_endpoint(input_data: RunAgentInput, request: Request):
    accept_header = request.headers.get("accept")
    encoder = EventEncoder(accept=accept_header)

    async def event_generator():
        yield encoder.encode(
            RunStartedEvent(
                type=EventType.RUN_STARTED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
        )

        message_id = str(uuid.uuid4())

        yield encoder.encode(
            TextMessageStartEvent(
                type=EventType.TEXT_MESSAGE_START,
                message_id=message_id,
                role="assistant",
            )
        )

        yield encoder.encode(
            TextMessageContentEvent(
                type=EventType.TEXT_MESSAGE_CONTENT,
                message_id=message_id,
                delta="Hello from AG-UI",
            )
        )

        yield encoder.encode(
            TextMessageEndEvent(
                type=EventType.TEXT_MESSAGE_END,
                message_id=message_id,
            )
        )

        yield encoder.encode(
            RunFinishedEvent(
                type=EventType.RUN_FINISHED,
                thread_id=input_data.thread_id,
                run_id=input_data.run_id,
            )
        )

    return StreamingResponse(
        event_generator(),
        media_type=encoder.get_content_type(),  # Python uses snake_case
    )
```

## Subsystem: SSE text encoder

The SSE encoder is the default path in `EventEncoder`. It serializes each event
as a single SSE `data:` line containing JSON.

**Wire format**: `data: <JSON-serialized event>\n\n`

Key implementation details from `encoder.ts`:
- `encode(event)` always returns an SSE string regardless of Accept header
- `encodeSSE(event)` is the explicit SSE method: ``data: ${JSON.stringify(event)}\n\n``
- `encodeBinary(event)` returns SSE bytes (via TextEncoder) when protobuf is not accepted
- Each event is self-contained on a single `data:` line -- no multi-line SSE
- No `event:` or `id:` SSE fields are used; only `data:`

The SSE format is parsed by standard `EventSource` APIs and AG-UI's `HttpAgent`
client. Every event must have a `type` field matching an `EventType` enum value.

## Subsystem: Protobuf binary encoder

The binary encoder uses protocol buffers via `@ag-ui/proto` for compact
serialization. It activates when the Accept header includes
`application/vnd.ag-ui.event+proto`.

**Wire format**: `[4-byte uint32 big-endian length][protobuf message bytes]`

Key implementation details from `proto.ts`:
- `proto.encode(event)` validates the event against Zod schemas before encoding
- If validation fails, it logs a warning and falls back to encoding the raw event
- The protobuf schema uses a `oneof` field keyed by camelCase event type name
- `BaseEvent` fields (type, timestamp, rawEvent) are stored in a nested `baseEvent` message
- `MESSAGES_SNAPSHOT` events ensure `toolCalls` arrays are always present (protobuf does not support optional arrays)
- `STATE_DELTA` events map JSON Patch operation names to protobuf enum values
- `proto.decode(data)` reverses these mappings and validates via Zod on output

The media type constant is exported from both packages:
```typescript
import { AGUI_MEDIA_TYPE } from "@ag-ui/encoder";
// or
import { AGUI_MEDIA_TYPE } from "@ag-ui/proto";
// Both resolve to "application/vnd.ag-ui.event+proto"
```

## Common Mistakes

### 1. Wrong or missing Accept header causing encoding mismatch

`EventEncoder` reads the Accept header at construction time to decide encoding.
Omitting it or passing the wrong value causes a mismatch between what the server
encodes and what the client expects to decode.

Wrong -- constructing encoder without the request's Accept header:

```typescript
// Server encodes as SSE, but client may expect protobuf
const encoder = new EventEncoder();
```

Wrong -- hardcoding an Accept value instead of reading from request:

```typescript
const encoder = new EventEncoder({ accept: "text/event-stream" });
// If the client sent Accept: application/vnd.ag-ui.event+proto, it gets SSE instead
```

Correct -- always pass the Accept header from the incoming request:

```typescript
// Express
const encoder = new EventEncoder({ accept: req.headers.accept });

// Node http
const encoder = new EventEncoder({ accept: req.headers["accept"] });
```

```python
# FastAPI
accept_header = request.headers.get("accept")
encoder = EventEncoder(accept=accept_header)
```

### 2. Missing Content-Type header in response

The server must set the Content-Type response header to match the encoder's
output format. Without it, the client cannot determine how to decode the stream,
causing parse failures.

Wrong -- hardcoding media_type or omitting it:

```python
return StreamingResponse(
    event_generator(),
    media_type="text/event-stream",  # Wrong: always SSE even when encoder uses protobuf
)
```

```typescript
res.setHeader("Content-Type", "text/event-stream"); // Wrong: ignores negotiation
```

Correct -- use the encoder's content type method:

```python
return StreamingResponse(
    event_generator(),
    media_type=encoder.get_content_type(),  # Matches negotiated format
)
```

```typescript
res.setHeader("Content-Type", encoder.getContentType()); // TS uses camelCase
```

### 3. Encoding events without a valid type field

Every event passed to the encoder must have a `type` field that matches an
`EventType` enum value. The protobuf encoder uses this as a discriminator to
select the correct oneof field. The SSE encoder serializes it as-is, but
downstream clients and the event verifier depend on it.

Wrong -- missing type field:

```typescript
encoder.encode({ messageId: "m1", delta: "hello" } as any);
// SSE: produces JSON without type, client cannot route the event
// Proto: encode() fails to find the oneof field, produces garbage or throws
```

Wrong -- typo in type value:

```typescript
encoder.encode({ type: "TEXT_MESSAGE" as any, messageId: "m1", delta: "hello" });
// Not a valid EventType -- proto encoder cannot map to oneof field
```

Correct -- always use the EventType enum:

```typescript
import { EventType } from "@ag-ui/core";

encoder.encode({
  type: EventType.TEXT_MESSAGE_CONTENT,
  messageId: "m1",
  delta: "hello",
});
```

The protobuf encoder validates events against Zod schemas before encoding. If
validation fails, it logs a warning and falls back to encoding the unvalidated
event. This fallback exists for backward compatibility but should not be relied on.

---

See also: agui-http-agent-setup -- HttpAgent uses the encoder for Accept/Content-Type negotiation
