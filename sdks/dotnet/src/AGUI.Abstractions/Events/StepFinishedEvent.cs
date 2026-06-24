using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/events.ts
public sealed class StepFinishedEvent : BaseEvent
{
    [JsonPropertyName("type")]
    public override string Type => AGUIEventTypes.StepFinished;

    [JsonPropertyName("stepName")]
    public string StepName { get; set; } = string.Empty;
}
