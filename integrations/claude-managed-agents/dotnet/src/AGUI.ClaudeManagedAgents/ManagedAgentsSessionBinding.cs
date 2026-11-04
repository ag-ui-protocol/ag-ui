namespace AGUI.ClaudeManagedAgents;
/// <summary>An authorized native conversation binding. The resolver must check caller access.</summary>
public sealed class ManagedAgentsSessionBinding
{
    public required string SessionId { get; init; }
    public string? LastEventId { get; set; }
    public string? SessionThreadId { get; init; }
    public string? LastUserMessageId { get; init; }
}
