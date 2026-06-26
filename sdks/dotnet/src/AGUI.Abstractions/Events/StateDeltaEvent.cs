using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event providing incremental state changes via JSON Patch (RFC 6902).
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StateDeltaEvent : BaseEvent
{
    /// <inheritdoc/>
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StateDelta;

    /// <summary>
    /// The delta payload as a raw JSON element.
    /// </summary>
    [JsonPropertyName("delta")]
    public JsonElement Delta { get; set; }
}
