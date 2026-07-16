using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class TextMessageContentEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.TextMessageContent;

    [JsonPropertyName("messageId")]
    public string MessageId { get; set; } = string.Empty;

    [JsonPropertyName("delta")]
    public string Delta { get; set; } = string.Empty;
}
