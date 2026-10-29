# Stock Microsoft Agent Framework approval coordination

This integration uses published Microsoft.Agents.AI 1.26.0 and Microsoft.Extensions.AI 10.11.0. It does not patch Microsoft assemblies, access private session keys, disable native approval binding, or require Microsoft's AG-UI host package. It targets .NET 10.

Wrap a stock `ChatClientAgent` in `DurableApprovalAgent`. Pass a callback that atomically saves the **complete native serialized session**, and a host-controlled list of frontend tool names. Create sessions and make **every** native execution through the wrapper. Native callers use ordinary `CreateSessionAsync`, `RunAsync` / `RunStreamingAsync`, `SerializeSessionAsync`, and `DeserializeSessionAsync`; no AG-UI transport is needed to create or continue a session. Retain the stock approval binder.

The wrapper records original approval requests in its own public `AgentSession.StateBag` entries. A decision for one of several requests is saved as coordinator-accepted intent. It is not yet a native execution or a tool result. The native agent runs only after every pending server approval and frontend result is supplied. Ordinary input arriving meanwhile is queued unchanged. A cold native serialize/deserialize roundtrip retains requests, accepted intent and queued input.

This is an independently packable `AGUI.MicrosoftAgentFramework` package. `AGUI.Server` and `AGUI.Abstractions` remain framework-agnostic; Microsoft dependencies belong to this integration only.

`GetPendingApprovals` and `GetAcceptedDecisions` expose this coordinator state. The latter must never be described as a result or as acceptance by Microsoft's native binder. Uninstrumented native sessions are rejected: installing this package later cannot establish which historic requests remain authoritative. Calls made directly against the inner agent bypass this contract and are unsupported.

## HTTP host integration

Authorize the requested thread, acquire a per-thread exclusive lease, and load its native session **before** calling:

```csharp
var jsonOptions = new JsonSerializerOptions(AIJsonUtilities.DefaultOptions);
jsonOptions.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);
await foreach (var evt in agent.RunAGUIAsync(
    input, session, jsonOptions, "your.approval_decisions", cancellationToken: ct))
{
    // Write evt using the normal AG-UI SSE serializer.
}
```

The host must preserve that lease for the entire enumeration and save callback. The wrapper's in-process gate protects only the same session object; it is not a distributed store lock. Do not trust a browser-provided serialized session or AG-UI state as native authority. Client-declared tool names must belong to the host-configured frontend set. Native tools and approval policy remain server configuration.

This entry point accepts **delta input**. `messages: []` plus `resume: [{ interruptId: ORIGINAL_ID, payload: { approved: true } }]` binds against the restored session. It does not require replayed call history or fabricate replacement IDs. A cancelled resume declines that original request. Unrecognized, stale, duplicate, already-answered and foreign IDs fail before the provider runs. A tool result may answer only an original pending frontend call; supplied results for native tools are rejected. Caller-supplied tool calls/approval requests cannot establish authority.

After persistence succeeds, the event stream emits a custom decision snapshot directly before `RUN_FINISHED`:

```json
{"version":1,"decisions":[{"requestId":"original","toolCallId":"original-call","approved":true,"status":"waiting"}]}
```

An empty decisions array clears the waiting display after native completion. The name is host-configured to match the UI/Intelligence consumer. Ordinary text updates stream as produced. Approval-bearing updates and the remaining tail wait until native completion and persistence; the host must not emit its own terminal success before this enumeration finishes.

## Mixed calls and recovery

Trusted frontend declarations (including `RunAgentInput.Tools`) are adapted to approval-gated functions before the native invocation pipeline. The stock SDK creates their original approval requests; the adapter's function body cannot execute a frontend tool. Their continuation requires the actual client result, never a server approval response. Tool schemas and metadata remain those of the original declaration.

The outer public `ChatClientFactory` adapter restores completed frontend calls adjacent to their exact supplied results before the stock binder and function invoker. It uses only recorded server originals, preserves IDs/name/arguments/metadata, and marks completed calls informational so they cannot execute on the server. Native approval binding remains enabled. Original frontend requests are retained for subsequent native history normalization for the session lifetime; applications must bound session lifetime/storage size. This integration does not infer eviction from browser history.

Before dispatching a native run, the wrapper durably records an in-flight marker. If the process crashes, native execution throws, stream consumption is abandoned, or post-execution saving fails, further runs fail closed until the application reconciles the native/tool state. This prevents automatic replay; it is **not** an exactly-once side-effect guarantee. External tools still need idempotency for such a guarantee. There is deliberately no public “clear uncertainty and retry” shortcut. Reconcile authoritative outcomes and migrate to a new session through application-controlled recovery.

The integration currently does not support replaying entire client conversation histories, transparently adopting uninstrumented sessions, or continuing a session through the unwrapped native agent. Save callbacks that partially persist and then throw must be treated as uncertain by the host. Authentication, durable atomic storage, leases and reconciliation remain application responsibilities.

## Intelligence/native archive import

The native serialized session now carries AG-UI-owned version-1 checkpoint state under the `agui.approvals.v1` namespace, instead of unpublished Microsoft binder state. Importers must restore it with the stock agent's `DeserializeSessionAsync` and call `ExportCheckpoint(session)`. This returns detached JSON with the following stable version-1 contract:

- `version`: `1`.
- `dispatchUncertain`: whether native execution started without a confirmed durable completion. Importers must not show this state as safely resumable.
- `pendingRequests`: original `ToolApprovalRequestContent` objects in public MEAI polymorphic JSON, including requests whose decisions have been collected but not dispatched.
- `acceptedDecisions`: collected `ToolApprovalResponseContent` objects in public MEAI JSON. These also occur in `bufferedMessages`; they are a projection, not additional transcript occurrences.
- `bufferedMessages`: exact ordered public MEAI `ChatMessage` JSON, retaining accepted decisions, frontend results and queued ordinary content. Preserve each original ID/content occurrence.
- `completedFrontendRequests`: original frontend requests retained for normalization of native history. These are authority/context records, not extra chat messages or permission to invoke a tool.

The export is a display/import projection, never a resume authorization input. Continue execution only from the trusted complete native session. Do not copy private StateBag keys or infer acceptance from history. Intelligence's existing importer for the earlier experimental Microsoft patches requires an adapter to this public export; this package alone does not update that importer or validate all six showcase rows.

## Verification

From `sdks/dotnet`, run:

```sh
dotnet test tests/AGUI.MicrosoftAgentFramework.UnitTests -m:1 -p:SignAssembly=false -p:TargetFrameworks=net10.0 -p:RestoreEnablePackagePruning=false
```

The pruning switch avoids an unrelated existing .NET 10 diagnostic in the multi-target AGUI.Abstractions dependency. Tests use deterministic `IChatClient` providers and the actual published Microsoft packages: cold native-only partial collection, queued input, original-ID delta resumes, saved waiting snapshots, mixed frontend/server continuation, grammar and exact result preservation, forged/duplicate rejection, and uncertain-dispatch recovery.

## Recovering a missing frontend result

After durable persistence, `RunAGUIAsync` emits a current-run `CUSTOM` event named
`ag-ui:pending-frontend-results` immediately before `RUN_FINISHED` (after the
host-named decision snapshot):

```json
{"version":1,"threadId":"thread","runId":"current-run","pending":[{"toolCallId":"original-call","toolName":"frontend_tool","arguments":{"value":22}}]}
```

This is the coordinator's current unanswered frontend checkpoint, including
original pending calls from earlier runs. Entries use the server-recorded call
ID, name, and JSON arguments; no-argument calls use `{}`. Server-owned calls,
accepted decisions, buffered frontend results, and previously completed frontend
requests are excluded. An empty `pending` array explicitly reports no missing
frontend results. Failed persistence or uncertain native dispatch emits no
successful checkpoint or `RUN_FINISHED`.

A runtime may use this event only from the active, authorized response matching
its thread and run, after validating the exact call name and arguments against
its persisted transcript. It may resubmit an already persisted result for that
same call; it must not rerun a client handler, infer missing results from silence,
or use a replayed/custom client event as authority. The coordinator continues to
validate every supplied result against the selected native session. This event
does not authorize server execution or bypass native approval decisions.
