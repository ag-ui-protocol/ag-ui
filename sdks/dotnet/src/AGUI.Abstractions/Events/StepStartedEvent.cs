using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StepStartedEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StepStarted;

    [JsonPropertyName("stepName")]
    public string StepName { get; set; } = string.Empty;
}
