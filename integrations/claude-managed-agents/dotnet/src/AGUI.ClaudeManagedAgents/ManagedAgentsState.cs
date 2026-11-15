using System.Text.Json;
using System.Text.Json.Nodes;
using AGUI.Abstractions;

namespace AGUI.ClaudeManagedAgents;

// Versioned native commits are the recovery source; the record caches only delivered snapshots.
internal static class ManagedAgentsState
{
    internal const string Name = "ag_ui_update_state";
    internal const string Prefix = "AG-UI shared state v1\n";
    internal static readonly JsonElement Definition = ManagedAgentsCustomTools.CustomToolFrom(Name,
        "Update shared application state. Read the latest AG-UI shared state v1 snapshot. Supply its expectedRevision. replace replaces the whole object; merge_patch recursively merges objects, deletes null members, and replaces arrays.",
        JsonSerializer.Deserialize<JsonElement>("""{"type":"object","properties":{"operation":{"type":"string","enum":["replace","merge_patch"]},"expectedRevision":{"type":"integer","minimum":0},"state":{"type":"object"},"patch":{"type":"object"}},"required":["operation","expectedRevision"],"additionalProperties":false}"""));

    internal static void Validate(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
            foreach (var property in value.EnumerateObject())
            {
                if (property.Name is "__proto__" or "constructor" or "prototype") throw new ArgumentException("Unsafe shared state key.");
                Validate(property.Value);
            }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var item in value.EnumerateArray()) Validate(item);
    }

    internal static string Snapshot(ManagedAgentsSessionRecord record, JsonElement state, long revision) => Prefix + JsonSerializer.Serialize(new
    { version = 1, owner = new { sessionId = record.SessionId, sessionThreadId = (string?)null }, revision, kind = "snapshot", state });

    internal static (JsonElement State, long Revision) Apply(ManagedAgentsSessionRecord record, JsonElement input)
    {
        if (record.SessionThreadId is not null) throw new ArgumentException("Shared state is writable only by the primary conversation.");
        if (!input.TryGetProperty("expectedRevision", out var expected) || !expected.TryGetInt64(out var revision) || revision != record.SharedStateRevision)
            throw new ArgumentException("Stale or invalid shared state revision.");
        var operation = input.GetProperty("operation").GetString();
        if (operation is not ("replace" or "merge_patch")) throw new ArgumentException("Unknown shared state operation.");
        var value = input.GetProperty(operation == "replace" ? "state" : "patch");
        if (value.ValueKind != JsonValueKind.Object) throw new ArgumentException("Shared state must be a JSON object.");
        Validate(value);
        var state = operation == "replace" ? value.Clone() : JsonSerializer.SerializeToElement(Merge(
            record.SharedState is { } previous ? JsonNode.Parse(previous.GetRawText()) : new JsonObject(), JsonNode.Parse(value.GetRawText())!));
        var changed = record.SharedState is not { } old || !JsonElement.DeepEquals(old, state);
        var emptyPatch = operation == "merge_patch" && !value.EnumerateObject().Any();
        var next = record.SharedStateRevision + (changed && !emptyPatch ? 1 : 0);
        if (next > 9007199254740991) throw new ArgumentException("Shared state revision exhausted.");
        return (state, next);
    }
    private static JsonNode Merge(JsonNode? target, JsonNode patch)
    {
        if (patch is not JsonObject updates) return patch.DeepClone();
        var result = target as JsonObject ?? new JsonObject();
        foreach (var entry in updates)
        {
            if (entry.Value is null) result.Remove(entry.Key);
            else result[entry.Key] = Merge(result[entry.Key]?.DeepClone(), entry.Value);
        }
        return result;
    }

    internal static StateDelivery? Attach(List<JsonElement> events, JsonElement? input, ManagedAgentsSessionRecord record)
    {
        if (record.SessionThreadId is not null) return null;
        if (input is not { ValueKind: not (JsonValueKind.Null or JsonValueKind.Undefined) } state) return null;
        if (state.ValueKind != JsonValueKind.Object) throw new ArgumentException("Shared state must be a JSON object.");
        Validate(state);
        if (record.SharedState is { } current && JsonElement.DeepEquals(current, state)) return null;
        // Approval-only/reconnect traffic must not pretend to commit state.
        var split = ManagedAgentsContext.Split(events);
        var companion = split.Results.LastOrDefault(evt => Type(evt) is "user.custom_tool_result" or "user.tool_result");
        var withResults = companion.ValueKind != JsonValueKind.Undefined;
        if (!withResults) companion = split.FollowUps.LastOrDefault(evt => Type(evt) == "user.message");
        if (companion.ValueKind == JsonValueKind.Undefined) return null;
        if (record.SharedStateRevision >= 9007199254740991) throw new ArgumentException("Shared state revision exhausted.");
        var revision = record.SharedStateRevision + 1;
        var position = events.IndexOf(companion) + 1;
        var block = JsonSerializer.SerializeToElement(new { type = "text", text = Snapshot(record, state, revision) });
        if (position < events.Count && Type(events[position]) == "system.message")
        {
            var blocks = events[position].GetProperty("content").EnumerateArray().Select(item => item.Clone()).Append(block).ToList();
            events[position] = JsonSerializer.SerializeToElement(new { type = "system.message", content = blocks });
        }
        else events.Insert(position, JsonSerializer.SerializeToElement(new { type = "system.message", content = new[] { block } }));
        return new(state.Clone(), revision, withResults);
    }

    internal static bool Restore(JsonElement evt, ManagedAgentsSessionRecord record, IReadOnlyDictionary<string, JsonElement> calls)
    {
        if (record.SessionThreadId is not null || !Primary(evt, record)) return false;
        if (evt.TryGetProperty("session_id", out var session) && (session.ValueKind != JsonValueKind.String || session.GetString() != record.SessionId)) return false;
        var type = Type(evt);
        if (type == "user.custom_tool_result")
        {
            if (!evt.TryGetProperty("is_error", out var error) || error.ValueKind != JsonValueKind.False ||
                !evt.TryGetProperty("custom_tool_use_id", out var id) || id.ValueKind != JsonValueKind.String ||
                !calls.TryGetValue(id.GetString()!, out var call) || Type(call) != "agent.custom_tool_use" ||
                !call.TryGetProperty("name", out var name) || name.GetString() != Name || !Primary(call, record)) return false;
        }
        else if (type != "system.message") return false;
        if (!evt.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) return false;
        var matches = content.EnumerateArray().Where(block => Type(block) == "text" && block.TryGetProperty("text", out var candidate) &&
            candidate.ValueKind == JsonValueKind.String && candidate.GetString()!.StartsWith(Prefix, StringComparison.Ordinal)).ToList();
        if (matches.Count != 1) return false;
        var text = matches[0].GetProperty("text");
        try
        {
            var envelope = JsonSerializer.Deserialize<JsonElement>(text.GetString()![Prefix.Length..]);
            if (envelope.GetProperty("version").GetInt32() != 1 || envelope.GetProperty("kind").GetString() != "snapshot") return false;
            var owner = envelope.GetProperty("owner");
            if (owner.GetProperty("sessionId").GetString() != record.SessionId || owner.GetProperty("sessionThreadId").ValueKind != JsonValueKind.Null) return false;
            var revision = envelope.GetProperty("revision").GetInt64(); var state = envelope.GetProperty("state");
            if (revision < 1 || revision > 9007199254740991 || revision <= record.SharedStateRevision || state.ValueKind != JsonValueKind.Object) return false;
            Validate(state);
            record.SharedState = state.Clone(); record.SharedStateRevision = revision;
            return true;
        }
        catch (Exception error) when (error is JsonException or InvalidOperationException or KeyNotFoundException or FormatException or ArgumentException) { return false; }
    }
    internal static bool Primary(JsonElement evt, ManagedAgentsSessionRecord record) =>
        (!evt.TryGetProperty("session_id", out var session) || session.ValueKind == JsonValueKind.String && session.GetString() == record.SessionId) &&
        (!evt.TryGetProperty("session_thread_id", out var thread) || thread.ValueKind == JsonValueKind.Null ||
        thread.ValueKind == JsonValueKind.String && thread.GetString() == record.PrimaryThreadId);
    private static string? Type(JsonElement value) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String ? type.GetString() : null;
}

internal sealed record StateDelivery(JsonElement State, long Revision, bool WithResults)
{
    internal bool Acknowledge(ManagedAgentsSessionRecord record, bool results)
    {
        if (results != WithResults) return false;
        record.SharedState = State.Clone(); record.SharedStateRevision = Revision;
        return true;
    }
}
