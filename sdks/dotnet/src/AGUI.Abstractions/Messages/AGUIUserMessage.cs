using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/types.ts
public sealed class AGUIUserMessage : AGUIMessage
{
    public override string Role => AGUIRoles.User;

    [JsonPropertyName("name")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Name { get; set; }

    [JsonPropertyName("encryptedValue")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? EncryptedValue { get; set; }

    // Wire format (string | InputContent[]) is owned by AGUIMessageJsonConverter.
    [JsonIgnore]
    public AGUIUserContent Content { get; set; }
}
