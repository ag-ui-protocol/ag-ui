# OpenResponses Event Support: Future Implementation

This document tracks OpenResponses SSE event types that are not yet translated to AG-UI events, along with analysis and implementation notes.

## Currently Supported Events

| OpenResponses Event | AG-UI Event | Notes |
|---|---|---|
| `response.created` | (state capture) | Stores `response_id` for stateful mode |
| `response.in_progress` | (ignored) | No AG-UI equivalent needed |
| `response.output_item.added` (message) | `TEXT_MESSAGE_START` | |
| `response.output_item.added` (function_call) | `TOOL_CALL_START` | |
| `response.output_text.delta` | `TEXT_MESSAGE_CONTENT` | |
| `response.output_text.done` | `TEXT_MESSAGE_END` | |
| `response.function_call_arguments.delta` | `TOOL_CALL_ARGS` | |
| `response.output_item.done` (function_call) | `TOOL_CALL_END` | |
| `response.reasoning_text.delta` | `THINKING_TEXT_MESSAGE_CONTENT` | Auto-emits START on first delta |
| `response.reasoning_text.done` | `THINKING_TEXT_MESSAGE_END` | |
| `response.refusal.delta` | `TEXT_MESSAGE_CONTENT` | Surfaced as assistant message |
| `response.refusal.done` | `TEXT_MESSAGE_END` | |
| `response.completed` | (triggers `RUN_FINISHED`) | |
| `response.failed` | `RUN_ERROR` | |

---

## Not Yet Supported

### Reasoning Summary Events

**Events:**
- `response.reasoning_summary_part.added`
- `response.reasoning_summary_text.delta`
- `response.reasoning_summary_text.done`
- `response.reasoning_summary_part.done`

**AG-UI mapping:** `THINKING_TEXT_MESSAGE_START/CONTENT/END` (separate message_id from raw reasoning)

**Analysis:** These provide a model-generated summary of its reasoning chain, as opposed to the raw reasoning tokens. Requires `reasoning: {summary: "detailed"}` in the request body, which in turn requires OpenAI org verification. The summary would use a separate `message_id` from raw reasoning events to distinguish the two streams.

**Implementation notes:**
- Add `_current_summary_id` state field to `EventTranslator`
- Handle `summary_part.added` as START, `summary_text.delta` as CONTENT, both `summary_text.done` and `summary_part.done` as END
- Forward `reasoning` config from `forwarded_props` in `RequestBuilder`
- Clean up summary state on `response.completed` and `reset()`

### Content Part Events (Multimodal Output)

**Events:**
- `response.content_part.added`
- `response.content_part.done`

**Analysis:** These signal when the model produces a new content part in its response (e.g., a generated image from DALL-E). Already defined in `OpenResponsesEventType` enum but not handled.

**Blocker:** AG-UI has no binary/image output event type. These events carry structured content (images, files) that cannot be represented as `TEXT_MESSAGE_CONTENT`. Options:
1. Wait for AG-UI to add a `BINARY_MESSAGE_CONTENT` event type (or similar)
2. Encode as base64 in a `CUSTOM` event
3. Serialize as a data URI in `TEXT_MESSAGE_CONTENT` (lossy, not recommended)

**Note:** Multimodal *input* (sending images/files to the model) already works via `RequestBuilder._translate_content_part()`.

### Usage / Token Count Events

**Events:** Not currently emitted as discrete SSE events by OpenResponses. Token usage is included in the `response.completed` event data payload (`response.usage`).

**AG-UI mapping:** No dedicated event type exists. Could use `CUSTOM` or `STATE_DELTA`.

**Implementation notes:**
- Extract `usage` from the `response.completed` data payload
- Include in `STATE_SNAPSHOT` alongside `response_id`, e.g. `openresponses_state.usage`
- Useful for cost tracking and rate limit awareness

### Rate Limit Headers

**Source:** HTTP response headers (`x-ratelimit-*`), not SSE events.

**Analysis:** Not accessible from the SSE event stream. Would need to be captured at the HTTP client level (`HttpClient`) and surfaced separately. Low priority — clients typically handle rate limits at a higher layer.
