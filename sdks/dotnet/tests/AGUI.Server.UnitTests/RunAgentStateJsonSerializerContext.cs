using System.Text.Json.Serialization;

namespace AGUI.Server.UnitTests;

[JsonSerializable(typeof(DocumentState))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(int[]))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.SnakeCaseLower)]
internal sealed partial class RunAgentStateJsonSerializerContext : JsonSerializerContext;
