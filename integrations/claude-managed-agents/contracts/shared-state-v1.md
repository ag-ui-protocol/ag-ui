# Managed shared state v1 (PNI-692 / PNI-694)

Reserved tool: `ag_ui_update_state`. Its canonical definition is in `state-tool-v1.json`; all languages register and validate that same definition. Native text prefix (exact, including newline): `AG-UI shared state v1\n`.

A commit text is that prefix followed by JSON:

```json
{
  "version": 1,
  "owner": { "sessionId": "session_1", "sessionThreadId": null },
  "revision": 1,
  "kind": "snapshot",
  "state": { "board": { "count": 1 } }
}
```

`state` is a JSON object. `revision` is a positive safe integer. `owner.sessionId` must match the native source session, and `owner.sessionThreadId` must match the logical source scope (null means primary). Native primary events may have a non-null `session_thread_id`; resolve the primary via native thread metadata (`parent_thread_id: null`), never treat a child cross-post as primary. v1 writes are primary-only; child activity cannot overwrite primary state. The application authorizes session bindings and partitions stores by caller; the envelope is not authorization.

A child reserved-state call remains an ordinary pending custom call under its original native ID. Skipping the primary-only handler is not an acknowledgement. Preserve and surface that pending call across reconnects until an actual native result or explicit client tool response completes it; do not fabricate an approval, success result, or primary state update.

## Native persistence and commit

Initial/client replacement snapshots occupy one uniquely prefixed text block in `system.message`, attached to the same send batch as a real user message or custom/tool result. Native requests allow at most one system.message, which must be final immediately following its companion. Runtime context and state share this event as separate text blocks. Consumers select exactly one state-prefixed block; multiple state-prefixed blocks are ambiguous and must not apply. A mere client input snapshot is not a native commit. Only successful native delivery emits AG-UI STATE_SNAPSHOT and updates the durable binding. Approval-only traffic cannot carry a changed system snapshot; preserve pending approvals and defer that state delivery to a supported companion.

Recovered pending state-tool results can themselves resume inference. Attach changed runtime context to that genuine result in the same native request, and acknowledge context only after successful delivery. The state result retains its original call ID and native revision; do not substitute the reconnecting client's state for the recovered write.

Required runtime context cannot be deferred past an approval that resumes inference. If only confirmations are available, reject changed context before sending them, even when a real user follow-up is also queued. A later user message is a separate request and does not protect the intervening continuation. A mixed batch with a genuine custom/tool result can carry context after that result. These constraints do not establish provider support for `system.message` following `user.tool_confirmation`; approval-only context transitions remain unsupported.

Model writes use `ag_ui_update_state` with `{operation:"replace",state:{...},expectedRevision:N}` or `{operation:"merge_patch",patch:{...},expectedRevision:N}`. Merge patch follows RFC 7396: recursive object merge, null deletes a member, arrays replace wholesale. Root state remains an object. Empty replacement `{}` clears state; empty patch is a no-op. A replacement can store JSON null members. Reject invalid/stale revisions and prototype-dangerous keys.

Successful writes persist a `user.custom_tool_result` with `is_error:false`, matching a native `agent.custom_tool_use` named exactly `ag_ui_update_state`, whose single text block contains the complete snapshot envelope above. The commit is the successful native result, never the tool call/request. Every result carries the complete resulting snapshot (including after a patch); consumers need no patch engine. Apply only after native send success. Failed/denied results and arbitrary tool results never change state. The tool result describes the new revision and state to the model.

## Replay, ordering, legacy

Enumerate native events in source order; deduplicate native event IDs first. Check owner before applying. Revisions start at 1 and increase by one per changed committed snapshot. Equal revisions with identical state are idempotent cross-posts; conflicting equal revisions and regressions must not overwrite current state. A later valid complete snapshot can recover without intermediate revisions. Do not sort lexically by event IDs. Unknown versions/malformed records are not state. No matching records means state is absent, not `{}`. Never infer state from model prose or ordinary user messages.

On continuation recover latest native state before deciding whether input differs. Missing/null input retains native state; a supplied object is an explicit full replacement, including `{}`. A reconnect without a sendable companion must not fabricate a commit. Local records cache committed state/revision, native events remain the recovery source.

## Catalog policy

Fresh sessions install the reserved tool without removing base tools. Imported sessions preserve their actual session tool catalog and append only the reserved tool when absent, at a safe user-turn boundary. Never replace unrelated imported tools with current frontend tools. Reserved-name conflicts fail explicitly. Pending approvals/children retain their catalog and ownership. Sessions already containing the compatible reserved tool can update state immediately.

## Fixtures

Native-shaped fixtures are deterministic test-provider output, not paid provider captures. They will be saved alongside this contract after exercising each producer. Paid acceptance and cross-repo UI/reload acceptance remain coordinator responsibilities.
