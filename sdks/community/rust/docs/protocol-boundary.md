# Protocol and application boundaries

The SDK implements AG-UI types, serialization, SSE framing, client/server stream
handling and generic transport bindings. An application can use the existing
`Agent`/`RunContext` interface or validate externally produced events through
`server::EventVerifier` (`server` + `verify`). The standalone verifier shares the
server's ordering and attribution checks without owning a task or event queue.
It accepts empty text/reasoning deltas and protocol-valid interleaved streams.
It does not invent subagent outcomes or require snapshots before an interrupt.
Schema semantics and stream ordering are separate checks; see the
[semantic interoperability suite](../e2e/interop/README.md).

Agent frameworks own durable admission, execution cancellation registries,
recovery, checkpoints, storage, approval policy and client-specific integrations
such as CopilotKit request/info/action envelopes. Applications supply authorization,
capability values, catalog content and business rules. Those concerns must not
become extra protocol constraints just because one consumer needs them.

The standalone `ag-ui-a2ui` remains a separate A2UI protocol and authoring crate,
outside this workspace. Its schemas and
conformance tests do not establish AG-UI conformance or determine what belongs in
an upstream Rust community SDK contribution.

## Consumer-owned JSON ordering

The workspace does not enable `serde_json/preserve_order`. Cargo unifies features
across a graph, so opting in inside a protocol library would also change unrelated
consumer serialization and potentially stored byte fingerprints. Consumers that
need insertion order should enable it on their own `serde_json` dependency.
JSON object member order is not a protocol contract; array order remains intact.

## Compatibility corrections

`TEXT_MESSAGE_START.role = null` is rejected instead of being treated as omitted;
only a missing role defaults to `assistant`. Run and subagent outcomes reject
unknown fields, including the success variant. Null or absent input state is
serialized as omitted, matching the reference SDK. Empty text/reasoning deltas
remain valid; applications may choose to suppress them at their publication layer.

Typed event decoding is not a lossless forwarder of unknown top-level properties,
and missing `forwardedProps` is represented as null. These existing representation
choices are documented and compared explicitly in the interoperability suite.
The verifier is a generic SDK API, not another set of wire event declarations.
It deliberately exposes no application-specific primary-stream or admission API.

## Community contribution

This branch proposes adopting the independent SDK under
[`sdks/community/rust`](https://github.com/ag-ui-protocol/ag-ui/issues/2256#issuecomment-5689944347).
Scope, ownership and publishing still require an upstream team decision. A discussion
or successful conformance check is not that approval. This workspace includes
`ag-ui`, the optional `ag-ui-a2ui` companion, the drift tool, and unpublished
tests. Application integration policies remain outside the SDK.
