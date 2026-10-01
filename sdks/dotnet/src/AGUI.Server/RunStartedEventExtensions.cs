using AGUI.Abstractions;

namespace AGUI.Server;

internal static class RunStartedEventExtensions
{
    extension(RunStartedEvent)
    {
        /// <summary>
        /// Builds the RUN_STARTED this server emits on the producer's behalf. It declares
        /// <see cref="AGUIProtocol.Version"/>, as the 1.0 spec requires of every producer.
        /// </summary>
        public static RunStartedEvent Create(string threadId, string runId, string? parentRunId = null) =>
            new()
            {
                ThreadId = threadId,
                RunId = runId,
                ParentRunId = parentRunId,
                ProtocolVersion = AGUIProtocol.Version,
            };
    }
}
