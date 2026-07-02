using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace AGUI.Abstractions;

// Keep in sync with sdks/typescript/packages/core/src/capabilities.ts
public sealed class MultiAgentCapabilities
{
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Supported { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Delegation { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Handoffs { get; set; }

    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IList<SubAgentInfo>? SubAgents { get; set; }
}
