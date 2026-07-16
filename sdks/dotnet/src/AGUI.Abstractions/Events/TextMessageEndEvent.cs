using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class TextMessageEndEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.TextMessageEnd;

    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;
}
