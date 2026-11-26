using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.ClaudeManagedAgents;

public sealed partial class ManagedAgentsAgent
{
    private async IAsyncEnumerable<BaseEvent> RunRecoveredAsync(RunAgentInput input, IList<AGUIMessage> messages,
        string key, ManagedAgentsSessionRecord record, RunContext run,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        // Establish the live connection first; all history IDs are suppressed on that same connection.
        var stream = await _client.OpenConversationStreamAsync(record.SessionId, record.SessionThreadId, _options.StreamDeltas, cancellationToken).ConfigureAwait(false);
        await using var streamScope = ((IAsyncDisposable)stream).ConfigureAwait(false);
        var history = await _client.ListSessionEventsAsync(record.SessionId, record.SessionThreadId, cancellationToken).ConfigureAwait(false);
        if (record.SessionThreadId is null && history.Any(evt => evt.TryGetProperty("session_thread_id", out var scope) && scope.ValueKind == JsonValueKind.String &&
            (StringOf(evt, "name") == ManagedAgentsState.Name || StringOf(evt, "type") is "system.message" or "user.custom_tool_result")))
            record.PrimaryThreadId = await _client.GetPrimaryThreadIdAsync(record.SessionId, cancellationToken).ConfigureAwait(false);
        record.SharedState = null;
        record.SharedStateRevision = 0;
        var clientTools = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var tool in input.Tools ?? []) clientTools[ManagedAgentsCustomTools.NormalizeToolName(tool.Name)] = tool.Name;
        var knownToolCalls = messages.OfType<AGUIAssistantMessage>().SelectMany(message => message.ToolCalls ?? []).Select(call => call.Id).ToHashSet(StringComparer.Ordinal);
        var knownMessages = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var message in messages.OfType<AGUIAssistantMessage>())
            if (message.Content is not null) knownMessages[message.Id] = message.Content;
        var knownResults = messages.OfType<AGUIToolMessage>().Select(message => message.ToolCallId).ToHashSet(StringComparer.Ordinal);
        record.DeliveredChildResultIds.UnionWith(knownResults);
        var cursor = record.LastEventId;
        var missed = new List<JsonElement>();
        var pastCursor = cursor is null && !record.PreserveTools;
        var running = false;
        var calls = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        var confirmations = new HashSet<string>(StringComparer.Ordinal);
        var answered = new HashSet<string>(StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var latestBlocking = new List<string>();
        foreach (var evt in history)
        {
            var id = StringOf(evt, "id");
            if (id is not null && !seen.Add(id)) continue;
            if (pastCursor) missed.Add(evt);
            if (cursor is not null && id == cursor) pastCursor = true;
            var type = StringOf(evt, "type");
            RememberChildCall(record, evt);
            if (type == "system.message") ManagedAgentsContext.Restore(evt, record);
            ManagedAgentsState.Restore(evt, record, calls);
            if (type == "session.status_running" || type == "session.thread_status_running" && StringOf(evt, "session_thread_id") == record.SessionThreadId) { latestBlocking.Clear(); running = true; }
            if ((type == "session.status_idle" || type == "session.thread_status_idle" && StringOf(evt, "session_thread_id") == record.SessionThreadId) && evt.TryGetProperty("stop_reason", out var stop))
            {
                running = false;
                if (StringOf(stop, "type") == "end_turn") { calls.Clear(); confirmations.Clear(); latestBlocking.Clear(); }
                else if (StringOf(stop, "type") == "requires_action" && stop.TryGetProperty("event_ids", out var ids))
                    latestBlocking = ids.EnumerateArray().Select(id => id.GetString()!).ToList();
            }
            if (type is "session.status_terminated" or "session.status_ended" or "session.deleted" || (type == "session.thread_status_terminated" && StringOf(evt, "session_thread_id") == record.SessionThreadId)) record.SessionEnded = true;
            if (id is not null && (type == "agent.custom_tool_use" ||
                (type is "agent.tool_use" or "agent.mcp_tool_use" && StringOf(evt, "evaluated_permission") == "ask")))
            {
                calls[id] = evt;
                if (type != "agent.custom_tool_use") confirmations.Add(id);
            }
            var resultId = type switch
            {
                "user.custom_tool_result" => StringOf(evt, "custom_tool_use_id"),
                "user.tool_confirmation" or "agent.tool_result" => StringOf(evt, "tool_use_id"),
                "agent.mcp_tool_result" => StringOf(evt, "mcp_tool_use_id"),
                _ => null,
            };
            if (resultId is not null) answered.Add(resultId);
        }
        if (record.SharedState is { } restoredState) yield return new StateSnapshotEvent { Snapshot = restoredState };
        foreach (var id in answered) { calls.Remove(id); confirmations.Remove(id); }
        record.PendingClientToolUseIds = calls.Keys.Where(id => !confirmations.Contains(id)).ToList();
        record.PendingConfirmationIds = confirmations.ToList();
        await PersistDeliveredAsync(key, record).ConfigureAwait(false);
        if (record.SessionEnded)
        {
            yield return new RunErrorEvent { Code = "session_terminated", Message = "The bound native session has terminated." };
            yield break;
        }

        if (cursor is not null && !pastCursor)
        {
            yield return new RunErrorEvent { Code = "session_unavailable", Message = "The native history cursor is unavailable." };
            yield break;
        }
        if (latestBlocking.Any(id => !answered.Contains(id) && !calls.ContainsKey(id)))
        {
            yield return new RunErrorEvent { Code = "session_unavailable", Message = "Native history is missing a pending tool request." };
            yield break;
        }

        // Validate the entire resume batch before any remote write.
        var replies = new List<JsonElement>();
        var resumed = new HashSet<string>(StringComparer.Ordinal);
        foreach (var resume in input.Resume ?? [])
        {
            var decision = resume.Status == "cancelled" ? "deny" :
                resume.Status == "resolved" && resume.Payload is { ValueKind: JsonValueKind.String } payload ? payload.GetString() : null;
            if (!confirmations.Contains(resume.InterruptId) || !resumed.Add(resume.InterruptId) || decision is not ("allow" or "deny"))
            {
                yield return new RunErrorEvent { Code = "invalid_resume", Message = "Resume must answer a pending native confirmation with allow or deny." };
                yield break;
            }
            replies.Add(ManagedAgentsSessionEvents.ToolConfirmation(resume.InterruptId, decision));
        }
        // A cold reconnect may find a reserved call whose result never landed. Resume it
        // under its original native ID, with the same revision and catalog checks as a live call.
        foreach (var pending in calls.Where(entry => StringOf(entry.Value, "type") == "agent.custom_tool_use" && StringOf(entry.Value, "name") == ManagedAgentsState.Name && record.SessionThreadId is null && ManagedAgentsState.Primary(entry.Value, record)).ToList())
        {
            var stateTurn = new ManagedAgentsTurn(_client, record.SessionId, [], clientTools, _backendTools, null, _options.StreamDeltas, onError: _options.OnError)
            { StateRecord = record, PersistState = () => PersistDeliveredAsync(key, record), Recovering = true, SuppressStateCall = knownToolCalls.Contains(pending.Key),
                AttachResultContext = batch => ManagedAgentsContext.Attach(batch, input.Context, record) };
            await foreach (var evt in stateTurn.ResumeStateCallAsync(pending.Value, cancellationToken).ConfigureAwait(false)) yield return evt;
            if (!stateTurn.IsAcknowledged(pending.Key)) yield break;
            answered.Add(pending.Key); calls.Remove(pending.Key); knownToolCalls.Add(pending.Key); knownResults.Add(pending.Key);
            record.PendingClientToolUseIds.Remove(pending.Key);
            running = true;
            await PersistDeliveredAsync(key, record).ConfigureAwait(false);
        }
        var outbound = OutboundEvents(record, messages);
        if (record.SessionThreadId is not null && outbound.Events.Any(evt => StringOf(evt, "type") == "user.message"))
        {
            yield return new RunErrorEvent { Code = "child_thread_message_unsupported", Message = "Native child threads do not support user messages." };
            yield break;
        }
        // Initial adoption assumes the importer already supplied history. Subsequent reconnects
        // replay only activity after the durable cursor, without executing any historical tools.
        foreach (var evt in missed)
        {
            yield return new RawEvent { Source = "claude-managed-agents", Event = evt };
            var id = StringOf(evt, "id")!;
            var type = StringOf(evt, "type");
            var blocks = evt.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array ? content.EnumerateArray().ToList() : null;
            if (type == "agent.message")
            {
                var text = ManagedAgentsText.TextOf(blocks);
                var suffix = text;
                if (knownMessages.TryGetValue(id, out var existing))
                {
                    if (!text.StartsWith(existing, StringComparison.Ordinal))
                    {
                        yield return new RunErrorEvent { Code = "history_content_conflict", Message = "Saved native text conflicts with the existing message." };
                        yield break;
                    }
                    suffix = text[existing.Length..];
                }
                knownMessages[id] = text;
                if (suffix.Length > 0)
                {
                    yield return new TextMessageStartEvent { MessageId = id, Role = AGUIRoles.Assistant };
                    yield return new TextMessageContentEvent { MessageId = id, Delta = suffix };
                    yield return new TextMessageEndEvent { MessageId = id };
                }
            }
            if (type is "agent.custom_tool_use" or "agent.tool_use" or "agent.mcp_tool_use" && !calls.ContainsKey(id) && knownToolCalls.Add(id))
            {
                yield return new ToolCallStartEvent { ToolCallId = id, ToolCallName = RecoveredToolName(evt, clientTools) };
                yield return new ToolCallArgsEvent { ToolCallId = id, Delta = evt.TryGetProperty("input", out var args) ? args.GetRawText() : "{}" };
                yield return new ToolCallEndEvent { ToolCallId = id };
            }
            var resultId = type switch { "agent.tool_result" => StringOf(evt, "tool_use_id"), "agent.mcp_tool_result" => StringOf(evt, "mcp_tool_use_id"), "user.custom_tool_result" => StringOf(evt, "custom_tool_use_id"), _ => null };
            if (resultId is not null && knownResults.Add(resultId) && (!record.ChildToolCalls.ContainsKey(resultId) || record.DeliveredChildResultIds.Add(resultId))) yield return new ToolCallResultEvent { MessageId = id, ToolCallId = resultId, Role = AGUIRoles.Tool, Content = ManagedAgentsContent.ToolContent(blocks, evt.TryGetProperty("is_error", out var error) && error.ValueKind == JsonValueKind.True) };
        }
        record.LastEventId = history.Select(evt => StringOf(evt, "id")).LastOrDefault(id => id is not null) ?? record.LastEventId;
        await PersistDeliveredAsync(key, record).ConfigureAwait(false);
        var remainingConfirmations = confirmations.Where(id => !resumed.Contains(id)).ToList();
        var stillPending = outbound.StillParked.Count > 0 || remainingConfirmations.Count > 0;
        if (calls.Count == 0 && outbound.LastUserMessageId is not null)
            await SyncClientToolsAsync(record, input.Tools, cancellationToken).ConfigureAwait(false);
        var sends = replies.Concat(outbound.Events.Where(evt => !stillPending || StringOf(evt, "type") != "user.message")).ToList();
        var contextDelivery = ManagedAgentsContext.Attach(sends, input.Context, record);
        var stateDelivery = ManagedAgentsState.Attach(sends, input.State, record);
        yield return new CustomEvent { Name = SessionCustomEventName, Value = JsonSerializer.SerializeToElement(new
        { sessionId = record.SessionId, threadId = input.ThreadId, sessionThreadId = record.SessionThreadId, resumed = true }) };

        if (stillPending || sends.Count == 0 && !running)
        {
            if (sends.Count > 0) await _client.SendEventsAsync(record.SessionId, sends, cancellationToken).ConfigureAwait(false);
            if (contextDelivery is not null) record.RuntimeContext = contextDelivery.Snapshot;
            if (stateDelivery?.Acknowledge(record, results: true) == true) yield return new StateSnapshotEvent { Snapshot = record.SharedState!.Value };
            record.PendingClientToolUseIds = outbound.StillParked;
            record.PendingConfirmationIds = remainingConfirmations;
            await PersistDeliveredAsync(key, record).ConfigureAwait(false);
            foreach (var id in record.PendingClientToolUseIds.Concat(record.PendingConfirmationIds))
            {
                if (!knownToolCalls.Add(id)) continue;
                var call = calls[id];
                yield return new ToolCallStartEvent { ToolCallId = id, ToolCallName = RecoveredToolName(call, clientTools) };
                yield return new ToolCallArgsEvent { ToolCallId = id, Delta = call.TryGetProperty("input", out var args) ? args.GetRawText() : "{}" };
                yield return new ToolCallEndEvent { ToolCallId = id };
            }
            await foreach (var result in RecoverChildResultsAsync(key, record, cancellationToken).ConfigureAwait(false)) yield return result;
            await PersistDeliveredAsync(key, record).ConfigureAwait(false);
            yield return RecoveredFinished(input, record, calls);
            yield break;
        }
        var turn = new ManagedAgentsTurn(_client, record.SessionId, sends, clientTools, _backendTools, null, _options.StreamDeltas,
            onResultsSent: () => { contextDelivery?.Acknowledge(record, results: true); if (stateDelivery?.Acknowledge(record, results: true) == true) run.Turn!.EmitState(record.SharedState!.Value); record.PendingClientToolUseIds = []; record.PendingConfirmationIds = []; return PersistDeliveredAsync(key, record); },
            onFollowUpsSent: () => { contextDelivery?.Acknowledge(record, results: false); if (stateDelivery?.Acknowledge(record, results: false) == true) run.Turn!.EmitState(record.SharedState!.Value); record.LastUserMessageId = outbound.LastUserMessageId ?? record.LastUserMessageId; return PersistDeliveredAsync(key, record); },
            onClientPark: id => { if (!record.PendingClientToolUseIds.Contains(id)) record.PendingClientToolUseIds.Add(id); return PersistDeliveredAsync(key, record); },
            onError: _options.OnError) { ConnectedStream = stream, Recovering = true };
        turn.StateRecord = record;
        turn.PersistState = () => PersistDeliveredAsync(key, record);
        turn.SeenEventIds.UnionWith(seen);
        turn.AcknowledgeHistory(answered);
        turn.OnEventHandled = id => { record.LastEventId = id; return PersistDeliveredAsync(key, record); };
        run.Turn = turn;
        await foreach (var evt in turn.RunAsync(cancellationToken).ConfigureAwait(false))
        {
            if (!TrackChildResult(record, evt)) continue;
            yield return evt;
        }
        record.PendingConfirmationIds = turn.PendingConfirmations;
        await RecordOutcomeAsync(key, record, turn.Outcome).ConfigureAwait(false);
        await PersistDeliveredAsync(key, record).ConfigureAwait(false);
        if (turn.Outcome.Status != ManagedAgentsTurnStatus.Errored)
        {
            await foreach (var result in RecoverChildResultsAsync(key, record, cancellationToken).ConfigureAwait(false)) yield return result;
            await PersistDeliveredAsync(key, record).ConfigureAwait(false);
            yield return RecoveredFinished(input, record, turn.ConfirmationEvents);
        }
    }

    private static bool TrackChildResult(ManagedAgentsSessionRecord record, BaseEvent evt)
    {
        if (evt is RawEvent raw && raw.Event is JsonElement native) RememberChildCall(record, native);
        return evt is not ToolCallResultEvent result || !record.ChildToolCalls.ContainsKey(result.ToolCallId)
            || record.DeliveredChildResultIds.Add(result.ToolCallId);
    }

    private static void RememberChildCall(ManagedAgentsSessionRecord record, JsonElement evt)
    {
        if (record.SessionThreadId is null && StringOf(evt, "type") is "agent.tool_use" or "agent.mcp_tool_use"
            && StringOf(evt, "session_thread_id") is { } thread && StringOf(evt, "id") is { } id)
            record.ChildToolCalls[id] = thread;
    }

    private async IAsyncEnumerable<BaseEvent> RecoverChildResultsAsync(string key, ManagedAgentsSessionRecord record,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        if (record.SessionThreadId is not null) yield break;
        var threads = record.ChildToolCalls.Where(call => !record.DeliveredChildResultIds.Contains(call.Key)).Select(call => call.Value).Distinct().ToList();
        foreach (var thread in threads)
        {
            var history = await _client.ListSessionEventsAsync(record.SessionId, thread, cancellationToken).ConfigureAwait(false);
            foreach (var evt in history)
            {
                var callId = StringOf(evt, "type") switch { "agent.tool_result" => StringOf(evt, "tool_use_id"), "agent.mcp_tool_result" => StringOf(evt, "mcp_tool_use_id"), _ => null };
                if (callId is null || !record.ChildToolCalls.TryGetValue(callId, out var owner) || owner != thread
                    || StringOf(evt, "session_thread_id") is { } scope && scope != thread
                    || !record.DeliveredChildResultIds.Add(callId)) continue;
                var scoped = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(evt.GetRawText())!;
                scoped["session_thread_id"] = JsonSerializer.SerializeToElement(thread);
                yield return new RawEvent { Source = "claude-managed-agents", Event = JsonSerializer.SerializeToElement(scoped) };
                var blocks = evt.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array ? content.EnumerateArray().ToList() : null;
                yield return new ToolCallResultEvent { MessageId = StringOf(evt, "id")!, ToolCallId = callId, Role = AGUIRoles.Tool, Content = ManagedAgentsContent.ToolContent(blocks, evt.TryGetProperty("is_error", out var error) && error.ValueKind == JsonValueKind.True) };
                await PersistDeliveredAsync(key, record).ConfigureAwait(false);
            }
        }
    }

    private static RunFinishedEvent RecoveredFinished(RunAgentInput input, ManagedAgentsSessionRecord record, IReadOnlyDictionary<string, JsonElement> calls) => new()
    {
        ThreadId = input.ThreadId, RunId = input.RunId,
        Outcome = record.PendingConfirmationIds.Count == 0 ? null : new RunFinishedInterruptOutcome
        {
            Interrupts = record.PendingConfirmationIds.Select(id => new AGUIInterrupt { Id = id, ToolCallId = id, Reason = "tool-approval",
                Metadata = JsonSerializer.SerializeToElement(new { sessionId = record.SessionId, sessionThreadId = calls.TryGetValue(id, out var call) ? StringOf(call, "session_thread_id") ?? record.SessionThreadId : record.SessionThreadId, toolName = calls.TryGetValue(id, out var named) ? StringOf(named, "name") : null }),
                ResponseSchema = JsonSerializer.SerializeToElement(new { type = "string", @enum = new[] { "allow", "deny" } }) }).ToList(),
        },
    };

    private static string RecoveredToolName(JsonElement call, IReadOnlyDictionary<string, string> clientTools)
    {
        var name = StringOf(call, "name") ?? "tool";
        return StringOf(call, "type") == "agent.custom_tool_use" && clientTools.TryGetValue(name, out var original) ? original : name;
    }

    private static string? StringOf(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
}
