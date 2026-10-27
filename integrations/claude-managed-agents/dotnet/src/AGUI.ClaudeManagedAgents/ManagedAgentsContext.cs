using System.Text.Json;
using AGUI.Abstractions;

namespace AGUI.ClaudeManagedAgents;

internal sealed class ContextDeliveryException(string message) : InvalidOperationException(message);

internal sealed record ContextDelivery(string Snapshot, bool WithResults)
{
    internal void Acknowledge(ManagedAgentsSessionRecord record, bool results)
    {
        if (results == WithResults) record.RuntimeContext = Snapshot;
    }
}

internal static class ManagedAgentsContext
{
    private const string Header = "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n";

    internal static ContextDelivery? Attach(List<JsonElement> events, IList<AGUIContext>? context, ManagedAgentsSessionRecord record)
    {
        var snapshot = JsonSerializer.Serialize(context ?? []);
        if (events.Count == 0 || snapshot == record.RuntimeContext || (snapshot == "[]" && record.RuntimeContext is null)) return null;
        if (record.SessionThreadId is not null) throw new ContextDeliveryException("Runtime context cannot be injected into a native child thread.");
        var results = events.Where(evt => evt.GetProperty("type").GetString() != "user.message").ToList();
        var companion = results.Count > 0 ? results[^1] : events[^1];
        if (companion.GetProperty("type").GetString() is not ("user.message" or "user.custom_tool_result" or "user.tool_result"))
            throw new ContextDeliveryException("Changed runtime context requires a user message or tool result; an approval alone cannot carry system context.");
        events.Insert(events.IndexOf(companion) + 1, JsonSerializer.SerializeToElement(new { type = "system.message", content = new[] { new { type = "text", text = Header + snapshot } } }));
        return new ContextDelivery(snapshot, results.Count > 0);
    }

    // Keep each system event with its companion when the parked-session request is split.
    internal static (List<JsonElement> Results, List<JsonElement> FollowUps) Split(IReadOnlyList<JsonElement> events)
    {
        List<JsonElement> results = [], followUps = [];
        var batch = followUps;
        foreach (var evt in events)
        {
            var type = evt.GetProperty("type").GetString();
            if (type != "system.message") batch = type == "user.message" ? followUps : results;
            batch.Add(evt);
        }
        return (results, followUps);
    }
    internal static void Restore(JsonElement evt, ManagedAgentsSessionRecord record)
    {
        if (record.SessionThreadId is not null || !evt.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) return;
        var matches = content.EnumerateArray().Where(block => block.ValueKind == JsonValueKind.Object &&
            block.TryGetProperty("type", out var type) && type.ValueKind == JsonValueKind.String && type.GetString() == "text" &&
            block.TryGetProperty("text", out var candidate) && candidate.ValueKind == JsonValueKind.String && candidate.GetString()!.StartsWith(Header, StringComparison.Ordinal)).ToList();
        if (matches.Count != 1) return;
        var text = matches[0].GetProperty("text").GetString()!;
        JsonElement entries;
        try { entries = JsonSerializer.Deserialize<JsonElement>(text[Header.Length..]); }
        catch (JsonException) { return; } // Unrelated/malformed native system text is not our snapshot.
        if (entries.ValueKind != JsonValueKind.Array) return;
        List<AGUIContext> context = [];
        foreach (var entry in entries.EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Object || !entry.TryGetProperty("description", out var description) || description.ValueKind != JsonValueKind.String || !entry.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.String) return;
            context.Add(new() { Description = description.GetString()!, Value = value.GetString()! });
        }
        record.RuntimeContext = JsonSerializer.Serialize(context);
    }

}
