using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Base class for all AG-UI protocol events.
/// </summary>
[JsonConverter(typeof(BaseEventJsonConverter))]
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public abstract class BaseEvent
{
    /// <summary>
    /// Gets the event type discriminator.
    /// </summary>
    [JsonPropertyName("type")]
    public abstract string Type { get; }

    /// <summary>
    /// Gets or sets the optional timestamp.
    /// </summary>
    [JsonPropertyName("timestamp")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? Timestamp { get; set; }

    /// <summary>
    /// Gets or sets the optional raw event data.
    /// </summary>
    [JsonPropertyName("rawEvent")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? RawEvent { get; set; }
}
