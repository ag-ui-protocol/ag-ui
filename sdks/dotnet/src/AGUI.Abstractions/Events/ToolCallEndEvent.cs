using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Event signaling the end of a tool call from the agent.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class ToolCallEndEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.ToolCallEnd;

    [JsonPropertyName("toolCallId")]
    public string ToolCallId { get; set; } = string.Empty;
}
