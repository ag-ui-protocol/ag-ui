using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIResume
{
    [JsonPropertyName("interruptId")]
    public string InterruptId { get; set; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; set; } = ResumeStatus.Resolved;

    [JsonPropertyName("payload")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Payload { get; set; }
}
