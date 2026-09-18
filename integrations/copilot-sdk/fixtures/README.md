# Shared Copilot SDK contract

`contract.json` is **synthetic**, not a live recording. Both native adapters
consume the same cases. Merge `envelopeDefaults` into each event, map the events
in order with a fresh mapper, and close open blocks at the end of each case.

The `expect` object describes the resulting AG-UI trace:

- `types`: exact sequence of event types.
- `text` / `reasoning`: concatenated deltas grouped by message ID in first-seen
  order. IDs must not be collapsed across child agents.
- `toolArguments`: parsed concatenated argument deltas, in first-seen call order.
- `toolResults`: exact result contents in emission order, including empty strings.
- `toolResultContains`: required fragments in the serialized tool results.
- `counts`: exact counts for the listed event types.
- `lastToolActivity`: required fields of the final `copilot-sdk:tool` snapshot.
- `activityOutputs`: exact output values at every tool activity snapshot, including
  progress-only updates. This catches loss/duplication before a final result masks it.
- `distinctTextMessageIds`: count of unique text message identities.
- `forbidden`: strings that must never appear in serialized output.
- `error`: exact mapper rejection text. Such cases must reject before emitting
  any child event; the parity harness verifies a `RUN_ERROR` envelope instead of
  a successful terminal.

Every trace must also satisfy start/content/end ordering, one end per start,
result-to-call correlation, and no unrestricted `RAW` events. Do not normalize
away semantic ordering, text, tool arguments, correlation, or terminal outcomes.
Timestamp and generated identity differences are the only permissible
normalizations for cross-language comparison.

Child-content cases announce their children first. The separate unannounced-child
cases verify fail-closed ownership in both mappers, including a completion that
must not fabricate a start. This is an adapter ownership invariant in addition
to the published verifier's checks, not a claim that every unknown child tag is
rejected by the verifier itself.

The pending-tool RPC is deliberately tested separately with fake SDK sessions
for hard cases and with real Copilot sessions for the native and browser gates.
Synthetic fixtures cannot prove authentication, model support, command-output
streaming, or actual CopilotKit continuation.

The managed runtime 1.0.85 native `bash` probe emitted cumulative
`partialOutput` snapshots (including repeated snapshots), despite the generated
event schema's generic "incremental" wording. Native shell output therefore
replaces the previous buffer; non-shell tool output follows the documented
incremental-chunk contract. This is an explicit tool-specific distinction, not a
prefix-based heuristic that would confuse legitimate repeated chunks with
snapshots. The completion's actual result remains authoritative and unmodified.
