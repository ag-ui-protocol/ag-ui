# Live conversation content contract

This describes the adapter implementation, not released product validation. TypeScript,
Python and .NET need independent release and application validation.

## Input and supported media

`RUN_STARTED.input` retains the original AG-UI messages, message IDs, content parts,
filenames in part metadata, source MIME types, state and run context. Recorder consumers
must retain that input even if the run subsequently reports an error.

User messages and frontend tool results accept text, image and document parts. Image
MIME types are PNG, JPEG, GIF and WebP; documents accept PDF and plain text. Inline
PDF/image sources map to native base64 blocks. Inline `text/plain` documents are decoded
from base64 as UTF-8 into a native `text` source (including original whitespace and BOM);
the original encoded data is retained in `RUN_STARTED.input`. Invalid UTF-8 is rejected
rather than silently replaced. URL sources remain URLs, and `file` sources map to
native file IDs when `provider` is absent or `anthropic`. The application must supply a
handle accessible to the configured Anthropic workspace. The adapter does not fetch
URLs, upload files, resolve foreign provider handles, or promise model comprehension.
Document `metadata.filename` becomes the native document title. Image names and other
app metadata remain in the original AG-UI input because the native image block has no
filename field.

Unsupported audio/video parts, foreign provider handles and unsupported media types are
skipped when sending to Claude, as required by AG-UI. The complete original input remains
recorded, including skipped parts. Supported parts keep their order and meaningful text
keeps its original whitespace. Whitespace-only parts within a meaningful message are retained; wholly blank user
messages do not create a new turn. In TypeScript, Python, and .NET, a frontend tool result
with no supported parts still answers the pending call with `content: []`. Zero-length
text parts in frontend tool results are omitted because Claude rejects empty text blocks; nonempty text and
supported media remain unchanged. The call is cleared only after delivery succeeds. The adapters
do not mount arbitrary files into the managed sandbox.

## Native output

Canonical `agent.*` and echoed `user.*` events exposed by the installed SDK are emitted
as `RAW` events with `source: "claude-managed-agents"`. They retain native identities,
content, errors, child-thread fields and other source fields. RAW is evidence, not an
additional chat message; consumers should not project it as a duplicate transcript item.
Unknown event types can only be forwarded if the installed SDK exposes them.

Native built-in and MCP results use the native result event ID as `messageId` and the
original tool-use event ID as `toolCallId`. Plain text is untruncated and untrimmed.
Mixed results use AG-UI content parts: images/documents carry their original bytes, URLs
or native file IDs; each part retains its source block at
`metadata.claudeManagedAgents`. Native-only blocks, including search results, use a
text representation of the complete JSON block plus this metadata, rather than a
truncated preview or placeholder. RAW retains the complete event envelope as well.

The existing input-state snapshot behavior is unchanged. State is owned and persisted
separately by the application or Intelligence; this adapter does not derive state updates
from tool results or write state/UI artifacts into native history.

## Companions and validation boundary

PNI-654 owns native extraction/import and Intelligence replay; PNI-656 owns original-session
recovery and approvals, now integrated here. Recovery replay reuses the live content
converters in all three ports, preserving native result IDs, complete rich content and
one original RAW envelope per recovered event. Combined regression tests exercise
built-in, MCP and frontend tool results recovered after a durable cursor, alongside
the existing recovery and approval suites. It does not prove
cloud execution, credential access, file download availability, browser rendering or the
six-row product checklist. PNI-660 documentation waits for release and final validation.

Native contracts: [session events](https://platform.claude.com/docs/en/managed-agents/events-and-streaming)
and [session files](https://platform.claude.com/docs/en/managed-agents/files).

## Intelligence compatibility blocker

Intelligence baseline [`7ec248a8f`](https://github.com/CopilotKit/Intelligence/blob/7ec248a8f/pnpm-lock.yaml) uses `@ag-ui/client` 0.0.57, whose `ToolCallResultEventSchema` rejects `ContentPart[]`. Its raw gateway accepts maps, but reconstruction's `stringifyContent` converts multipart arrays into JSON text. [PNI-663](https://linear.app/copilotkit/issue/PNI-663) owns the separate live recorder and reconstruction compatibility work. This branch is not product-review-ready until that companion is implemented and validated.
