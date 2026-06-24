using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing a full state snapshot.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StateSnapshotEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StateSnapshot;

    /// <summary>
    /// The complete state object serialized as a JSON element.
    /// </summary>
    [JsonPropertyName("snapshot")]
    public JsonElement Snapshot { get; set; }
}
