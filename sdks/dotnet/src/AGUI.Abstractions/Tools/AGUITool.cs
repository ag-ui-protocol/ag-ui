using System.Text.Json;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

/// <summary>
/// Represents a tool available for the agent to use.
/// </summary>
// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUITool
{
    /// <summary>
    /// Gets or sets the name of the tool.
    /// </summary>
    [JsonPropertyName("name")]
    public string Name { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the description of the tool.
    /// </summary>
    [JsonPropertyName("description")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Description { get; set; }

    /// <summary>
    /// Gets or sets the JSON Schema describing the tool's parameters.
    /// </summary>
    [JsonPropertyName("parameters")]
    public JsonElement Parameters { get; set; }

    /// <summary>
    /// Gets or sets arbitrary tool metadata (e.g. a2ui schema).
    /// </summary>
    [JsonPropertyName("metadata")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public JsonElement? Metadata { get; set; }
}
