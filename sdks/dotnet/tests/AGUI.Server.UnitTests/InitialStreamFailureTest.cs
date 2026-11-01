using System.Diagnostics;
using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class InitialStreamFailureTest
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BeforeFirstUpdate_StartsRunBeforeSanitizedErrorAsync(bool instrumented)
    {
        using var listener = new ActivityListener
        {
            ShouldListenTo = source => instrumented && source.Name == AGUIServerInstrumentation.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllData,
        };
        ActivitySource.AddActivityListener(listener);
        var input = new RunAgentInput { ThreadId = "thread", RunId = "run", Messages = [] };
        var context = input.ToChatRequestContext(AIJsonUtilities.DefaultOptions);
        var events = new List<BaseEvent>();
        await foreach (BaseEvent item in FailAsync().AsAGUIEventStreamAsync(context)) { events.Add(item); }
        Assert.Collection(events,
            item => Assert.IsType<RunStartedEvent>(item),
            item => Assert.Equal("StreamingError", Assert.IsType<RunErrorEvent>(item).Code));
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> FailAsync([EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        await Task.Yield();
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.IsCancellationRequested) { throw new InvalidOperationException("sensitive provider error"); }
        yield break;
    }
}
