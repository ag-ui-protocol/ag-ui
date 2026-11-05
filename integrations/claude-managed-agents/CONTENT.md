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

## Runtime context

All three Managed adapters forward `RunAgentInput.context` descriptions and values as
one native `system.message` snapshot, preserving order, whitespace, Unicode, and schema
text. It accompanies the user message or tool-result batch that first resumes inference;
no synthetic user message is created and recorded AG-UI input remains unchanged.
The complete snapshot instructs the model to supersede earlier runtime snapshots. An
empty list clears the effective runtime context after a prior snapshot. Native history
is append-only: clearing does not erase earlier values from the provider's history.

The last successfully delivered snapshot is persisted per session (`runtimeContext` /
`runtime_context` / `RuntimeContext`). Custom stores must retain that optional field.
Recovery also restores the latest recognized snapshot from native history, including
when an imported session has no local record. Unchanged snapshots are not resent; a
failed native send does not acknowledge delivery. An unchanged context can therefore
survive approval-only continuation, restarts, and native imports. Passive reconnects
without a new user message or tool answer do not manufacture a model turn.

This uses the native system-injection API and requires a
[supported primary model](https://platform.claude.com/docs/en/managed-agents/events-and-streaming#supported-models)
(the examples default to Sonnet 5.5, `claude-sonnet-5-5`). Setup reuses existing agents
without updating their model; existing Sonnet 5 examples must be reprovisioned as
described in each example README, then used with new sessions. System injection applies to the primary thread.
Changed context cannot accompany an approval-only reply or target a native child thread;
those attempts return `RUN_ERROR` with `context_delivery_unsupported` before sending the
reply. They must be retried through a supported primary user-message/tool-result turn,
or with the previously delivered context for an approval. Context is never silently
redirected from a child into its parent session. Applications should provide context
only through their trusted runtime and continue to authorize native session bindings.

Deterministic tests capture serialized HTTP requests from the real Anthropic SDKs,
plus fresh, continuing, imported, cold-store, partial-result, failed-send, and isolation
cases. They verify forwarding, not model compliance with an A2UI schema. No paid
provider calls are needed for these tests; generated UI validity remains a separate
live-model validation question.

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

## Child results after approval

The root stream may cross-post a child's tool call and approval confirmation without
cross-posting its result. All three adapters reconcile the owning child history before
finishing initial or recovered runs, using only call-to-child mappings from native root events.
They emit the actual native result under its original call and result IDs. Recovered
RAW envelopes include the child thread scope and preserve `is_error` and native content.
Confirmation decisions and parent prose never become tool results.

Session stores must round-trip the new child ownership and delivered-result fields.
These fields are independent of the root cursor: an empty child read remains eligible
for recovery on a later reload, and a delivered result is suppressed on subsequent
reads or root cross-posts. Results already present in the client transcript are also
recorded as delivered, even when no new result is emitted. The importing application remains responsible for persisting
AG-UI events; this adapter does not write directly to Intelligence.

`fixtures/child-results.json` preserves the captured TypeScript allow, Python deny,
and .NET allow provider events from PNI-688. Tests replay them without provider calls,
plus wrong-scope, duplicate, delayed-result, and serialized-store restart cases.
