using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

// Runs on its own so no ActivityListener from another test class is attached, which keeps
// AsAGUIEventStreamAsync on the uninstrumented path these tests are about.
[CollectionDefinition(Name, DisableParallelization = true)]
public sealed class NoActivityListenerCollection
{
    public const string Name = "No ActivityListener";
}

[Collection(NoActivityListenerCollection.Name)]
public sealed class StreamErrorCallbackTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    [Fact]
    public async Task StreamThrows_CallbackReceivesOriginalException_AndWireErrorStaysSanitized()
    {
        Assert.False(AGUIServerInstrumentation.ActivitySource.HasListeners());
        var thrown = new InvalidOperationException("sensitive downstream detail");
        var observed = new List<Exception>();
        var options = new AGUIStreamOptions().OnStreamError(observed.Add);

        var events = await CollectAsync(ThrowAfterUpdate(thrown), options);

        Assert.Same(thrown, Assert.Single(observed));
        var error = Assert.Single(events.OfType<RunErrorEvent>());
        Assert.Same(error, events[^1]);
        Assert.Equal("StreamingError", error.Code);
        Assert.Equal("An error occurred while streaming the agent response.", error.Message);
        Assert.DoesNotContain("sensitive", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(events, e => e is RunFinishedEvent);
    }

    [Fact]
    public async Task StreamThrows_EveryRegisteredCallbackIsInvoked()
    {
        var thrown = new InvalidOperationException("boom");
        var first = new List<Exception>();
        var second = new List<Exception>();
        var options = new AGUIStreamOptions().OnStreamError(first.Add).OnStreamError(second.Add);

        await CollectAsync(ThrowAfterUpdate(thrown), options);

        Assert.Same(thrown, Assert.Single(first));
        Assert.Same(thrown, Assert.Single(second));
    }

    [Fact]
    public async Task CallbackThrows_RunStillEndsWithSingleSanitizedRunError()
    {
        Assert.False(AGUIServerInstrumentation.ActivitySource.HasListeners());
        var after = new List<Exception>();
        var options = new AGUIStreamOptions()
            .OnStreamError(_ => throw new InvalidOperationException("callback failed"))
            .OnStreamError(after.Add);

        var events = await CollectAsync(ThrowAfterUpdate(new InvalidOperationException("boom")), options);

        var error = Assert.Single(events.OfType<RunErrorEvent>());
        Assert.Same(error, events[^1]);
        Assert.Equal("StreamingError", error.Code);
        Assert.Equal("An error occurred while streaming the agent response.", error.Message);
        Assert.Single(after);
    }

    [Fact]
    public async Task CallerCancellation_DoesNotInvokeCallback()
    {
        Assert.False(AGUIServerInstrumentation.ActivitySource.HasListeners());
        using var cts = new CancellationTokenSource();
        var observed = new List<Exception>();
        var context = new RunAgentInput { ThreadId = "thread-1", RunId = "run-1" }
            .ToChatRequestContext(SerializerOptions, new AGUIStreamOptions().OnStreamError(observed.Add));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var evt in TwoUpdates().AsAGUIEventStreamAsync(context, cts.Token).ConfigureAwait(false))
            {
                if (evt is TextMessageContentEvent)
                {
                    cts.Cancel();
                }
            }
        });

        Assert.Empty(observed);
    }

    [Fact]
    public async Task SuccessfulRun_DoesNotInvokeCallback()
    {
        var observed = new List<Exception>();

        var events = await CollectAsync(TwoUpdates(), new AGUIStreamOptions().OnStreamError(observed.Add));

        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Empty(observed);
    }

    [Fact]
    public void OnStreamError_NullCallback_Throws()
    {
        Assert.Throws<ArgumentNullException>(() => new AGUIStreamOptions().OnStreamError(null!));
    }

    private static async Task<List<BaseEvent>> CollectAsync(
        IAsyncEnumerable<ChatResponseUpdate> updates, AGUIStreamOptions options)
    {
        var context = new RunAgentInput { ThreadId = "thread-1", RunId = "run-1" }
            .ToChatRequestContext(SerializerOptions, options);
        var events = new List<BaseEvent>();
        await foreach (var evt in updates.AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ThrowAfterUpdate(Exception exception)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        await Task.Yield();
        throw exception;
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> TwoUpdates(
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
        await Task.Yield();
        yield return new ChatResponseUpdate(ChatRole.Assistant, " more");
    }
}
