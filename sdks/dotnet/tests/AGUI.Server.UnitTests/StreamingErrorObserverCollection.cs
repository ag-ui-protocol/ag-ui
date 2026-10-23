using Xunit;

namespace AGUI.Server.UnitTests;

// Activity listeners are process-wide. These tests must also exercise the path
// with no listener, without a concurrent telemetry test enabling it.
[CollectionDefinition(nameof(StreamingErrorObserverCollection), DisableParallelization = true)]
public sealed class StreamingErrorObserverCollection
{
}
