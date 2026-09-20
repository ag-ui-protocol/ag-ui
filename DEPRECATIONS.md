# Deprecations

The shims the SDKs still carry for peers speaking a pre-1.0 protocol. Each
entry names what was retired, what replaces it, where the shim lives, and
when the shim itself expires. Every shim below shipped in 1.0, released on
2026-09-17, and every date is twelve months from that release rather than from
when the individual shim was written. After the expiry date the shim may be
removed in the next release, and the deprecated shape stops working entirely.

The canonical 1.0 contract (spec/1.0/schema.json) excludes these shapes.
Compatibility conversions live in the TypeScript client boundary and
middleware layer: the
always-on boundary (`CompatibilityBoundary`) upgrades what arrives and converts
legacy binary attachments in outgoing requests before the transport runs.
Three version-gated middlewares are inserted when the peer ceiling is at or
below their version. They do not all work in the same direction.
`BackwardCompatibility_0_0_39` rewrites the `RunAgentInput` on its
way out; `_0_0_57` does both, sanitising
the input and then filtering and rewriting the stream (it drops the `SUBAGENT_*`
events and strips `subagentRunId` from the survivors — `MESSAGES_SNAPSHOT`
messages, `RUN_STARTED.input` messages, `RUN_FINISHED` interrupt outcomes);
and `_0_0_45` touches the input not at
all — it maps the RETURNED event stream, translating the `THINKING_*` shapes an
old peer sends back into `REASONING_*`. Every inbound conversion warns;
outbound, the warnings fire where a conversion loses or strands content (the
non-lossy binary upgrade for a modern peer is silent).
`SUPPRESS_TRANSFORMATION_WARNINGS=true` silences the warnings, not the
conversions.

| Deprecated shape                                                                            | Replacement                                                                                                               | Shim                                                                  | Expires    |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| `THINKING_START` event                                                                      | `REASONING_START`                                                                                                         | inbound boundary (and `BackwardCompatibility_0_0_45` for gated flows) | 2027-09-17 |
| `THINKING_END` event                                                                        | `REASONING_END`                                                                                                           | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-09-17 |
| `THINKING_TEXT_MESSAGE_START` event                                                         | `REASONING_MESSAGE_START`                                                                                                 | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-09-17 |
| `THINKING_TEXT_MESSAGE_CONTENT` event                                                       | `REASONING_MESSAGE_CONTENT`                                                                                               | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-09-17 |
| `THINKING_TEXT_MESSAGE_END` event                                                           | `REASONING_MESSAGE_END`                                                                                                   | inbound boundary (and `BackwardCompatibility_0_0_45`)                 | 2027-09-17 |
| `{ type: "binary" }` input content part                                                     | the media parts (`image`, `audio`, `video`, `document`) with a `source`                                                   | always-on boundary, on requests and response events                   | 2027-09-17 |
| `parentMessageId: null` on `TOOL_CALL_START`                                                | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `parentMessageId: null` on `TOOL_CALL_CHUNK`                                                | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `outcome: null` on `RUN_FINISHED`                                                           | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `rawEvent: null` on an event                                                                | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `result: null` on `RUN_FINISHED`                                                            | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `result: null` on `SUBAGENT_FINISHED`                                                       | omit the field                                                                                                            | inbound boundary                                                      | 2027-09-17 |
| `payload: null` on a resume entry                                                           | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `metadata: null` on an `image` content part                                                 | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `metadata: null` on an `audio` content part                                                 | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `metadata: null` on a `video` content part                                                  | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `metadata: null` on a `document` content part                                               | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `parameters: null` on a tool                                                                | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `forwardedProps: null` on `RunAgentInput`                                                   | omit the field                                                                                                            | inbound boundary (events)                                             | 2027-09-17 |
| `InputContent` and the `...InputContent` / `InputContent...Source` type and validator names | `ContentPart`, `TextPart`, `ImagePart`, `AudioPart`, `VideoPart`, `DocumentPart`, `PartSource`, `DataSource`, `UrlSource` | exported aliases of the same types in `@ag-ui/core` and `ag_ui.core`  | 2027-09-17 |
| `BinaryInputContent` (Python `ag_ui.core`) | the media parts (`ImagePart`, `AudioPart`, `VideoPart`, `DocumentPart`) with a `DataSource` or `UrlSource` | exported as a standalone class so an adapter written against 0.x still imports; no message shape carries it, and a `binary` part is rejected at `RunAgentInput` validation | 2027-09-17 |
| `SubAgentInfo` (Python `ag_ui.core`) | `SubagentInfo` | exported alias of the same class; the wire key is `subagents` only | 2027-09-17 |

The `BackwardCompatibility_0_0_47` class and public export have been removed.
Its binary conversion now runs in `CompatibilityBoundary` regardless of the
peer ceiling. Remove explicit imports and registrations of that old class.
When a message includes a modern attachment and its legacy binary mirror, the
boundary retains the modern part and its metadata. It only removes a legacy
mirror with matching media type, source kind, MIME type and payload or URL;
any legacy filename must also be retained by the modern part. Repeated modern
attachments and legacy-only attachments remain separate entries.

The optional-null conversions preserve compatibility with shapes the previous
SDK accepted. They run before validation on incoming events, including nested
messages and `RUN_STARTED.input`, across in-memory runs, reconnects, SSE and
protobuf. Direct request parsing does not pass through this event boundary.
Request handlers accepting older inputs must locally omit the listed optional
nulls before strict validation; CopilotKit's shared run/connect parser is this
explicit exception. The conversion helper remains internal to AG-UI, with no
public request-normalization API. Canonical schemas still reject these whole
optional nulls, and producer serializers omit them. The existing
`RunAgentInput.state: null` parser tolerance continues to yield `undefined`.

This is a selective compatibility list: event or message `metadata: null` and
`parentRunId: null` already failed validation and remain invalid. Required JSON
payloads such as `CUSTOM.value: null` remain valid.

A `null` **value under a metadata key** is not on this list and never will
be: metadata is open by key and a null value there is data. Only a `null` in
place of a whole optional field was ever a deviation.
