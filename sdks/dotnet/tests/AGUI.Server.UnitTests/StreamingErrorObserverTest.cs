using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

[Collection(nameof(StreamingErrorObserverCollection))]
public sealed class StreamingErrorObserverTest
{
    [Theory]
    [InlineData("none", false)]
    [InlineData("none", true)]
    [InlineData("record", false)]
    [InlineData("record", true)]
    [InlineData("drop", false)]
    [InlineData("drop", true)]
    public async Task Failure_ReportsOriginalExceptionBeforeTerminalEvent(string tracing, bool yieldThread)
    {
        Activity? completedActivity = null;
        using var listener = Listen(tracing, activity => completedActivity = activity);
        var failure = CreateFailure();
        Exception? observed = null;
        ChatRequestContext? observedContext = null;
        var calls = 0;
        var disposals = 0;
        var options = new AGUIStreamOptions()
            .WithUsageProvider("synthetic-provider")
            .OnStreamingError((exception, request) =>
            {
                calls++;
                observed = exception;
                observedContext = request;
            });
        var context = CreateContext(options);
        var events = new List<BaseEvent>();

        await foreach (var evt in ThrowingUpdates(failure, yieldThread, () => disposals++)
            .AsAGUIEventStreamAsync(context))
        {
            events.Add(evt);
            if (evt is RunErrorEvent)
            {
                // A consumer may stop at the terminal event and never ask for another item.
                Assert.Equal(1, calls);
                break;
            }
        }

        Assert.Same(failure, observed);
        Assert.Same(context, observedContext);
        Assert.Same(failure.InnerException, observed!.InnerException);
        Assert.Equal("synthetic-sensitive-value", observed.Data["detail"]);
        Assert.Contains(nameof(ThrowingUpdates), observed.StackTrace!);
        Assert.Contains(nameof(CreateFailure), observed.InnerException!.StackTrace!);
        Assert.Equal(1, calls);
        Assert.Equal(1, disposals);
        Assert.DoesNotContain(events, evt => evt is RunFinishedEvent);
        var error = Assert.Single(events.OfType<RunErrorEvent>());
        AssertSanitized(error);
        var usage = Assert.Single(error.Usage!);
        Assert.Equal("synthetic-provider", usage.Provider);
        Assert.Equal("synthetic-model", usage.Model);
        Assert.Equal(7, usage.InputTokens);

        if (tracing == "record")
        {
            Assert.NotNull(completedActivity);
            Assert.Equal(AGUIServerInstrumentation.ActivitySourceName, completedActivity.Source.Name);
            Assert.Equal(ActivityStatusCode.Error, completedActivity.Status);
            Assert.Equal("error", completedActivity.GetTagItem("agui.run.outcome"));
            Assert.Equal(events.Count, completedActivity.GetTagItem("agui.events.count"));
        }
        else
        {
            Assert.Null(completedActivity);
        }
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task ProviderCancellation_ReportsOriginalException(string tracing)
    {
        using var listener = Listen(tracing);
        var failure = new OperationCanceledException("synthetic provider timeout");
        var observed = new List<Exception>();
        var context = CreateContext(new AGUIStreamOptions().OnStreamingError((exception, _) => observed.Add(exception)));

        var events = await CollectAsync(ThrowingUpdates(failure), context);

        Assert.Same(failure, Assert.Single(observed));
        AssertSanitized(Assert.Single(events.OfType<RunErrorEvent>()));
        Assert.DoesNotContain(events, evt => evt is RunFinishedEvent);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task MappingFailure_ReportsOriginalException(string tracing)
    {
        using var listener = Listen(tracing);
        var failure = CreateFailure();
        var observed = new List<Exception>();
        var options = new AGUIStreamOptions()
            .MapCall("lookup", _ => throw failure)
            .OnStreamingError((exception, _) => observed.Add(exception));
        var update = new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new FunctionCallContent("synthetic-call", "lookup", new Dictionary<string, object?>())],
        };

        var events = await CollectAsync(Updates(update), CreateContext(options));

        Assert.Same(failure, Assert.Single(observed));
        var error = Assert.Single(events.OfType<RunErrorEvent>());
        Assert.Equal("StreamingError", error.Code);
        Assert.Equal("An error occurred while streaming the agent response.", error.Message);
        Assert.DoesNotContain(events, evt => evt is RunFinishedEvent);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task ThrowingObserver_PreservesSanitizedErrorAndDisposal(string tracing)
    {
        using var listener = Listen(tracing);
        var calls = 0;
        var disposals = 0;
        var options = new AGUIStreamOptions().OnStreamingError((_, _) =>
        {
            calls++;
            throw new IOException("synthetic observer failure");
        });

        var events = await CollectAsync(
            ThrowingUpdates(CreateFailure(), onDisposed: () => disposals++), CreateContext(options));

        Assert.Equal(1, calls);
        Assert.Equal(1, disposals);
        AssertSanitized(Assert.Single(events.OfType<RunErrorEvent>()));
        Assert.DoesNotContain(events, evt => evt is RunFinishedEvent);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task CallerCancellation_PropagatesWithoutNotifyingObserver(string tracing)
    {
        using var listener = Listen(tracing);
        using var cancellation = new CancellationTokenSource();
        var calls = 0;
        var options = new AGUIStreamOptions().OnStreamingError((_, _) => calls++);
        var context = CreateContext(options);
        var events = new List<BaseEvent>();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            await foreach (var evt in Updates(new ChatResponseUpdate(ChatRole.Assistant, "partial"))
                .AsAGUIEventStreamAsync(context, cancellation.Token).ConfigureAwait(true))
            {
                events.Add(evt);
                if (evt is TextMessageContentEvent)
                {
                    cancellation.Cancel();
                }
            }
        });

        Assert.Equal(0, calls);
        Assert.DoesNotContain(events, evt => evt is RunErrorEvent or RunFinishedEvent);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task SuccessfulRun_DoesNotNotifyObserver(string tracing)
    {
        using var listener = Listen(tracing);
        var calls = 0;
        var options = new AGUIStreamOptions().OnStreamingError((_, _) => calls++);

        var events = await CollectAsync(
            Updates(new ChatResponseUpdate(ChatRole.Assistant, "success")), CreateContext(options));

        Assert.Equal(0, calls);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.DoesNotContain(events, evt => evt is RunErrorEvent);
    }

    [Theory]
    [InlineData("none")]
    [InlineData("record")]
    [InlineData("drop")]
    public async Task ExplicitErrorEvent_DoesNotInventAnExceptionForObserver(string tracing)
    {
        using var listener = Listen(tracing);
        var calls = 0;
        var options = new AGUIStreamOptions().OnStreamingError((_, _) => calls++);
        var supplied = new RunErrorEvent { Code = "synthetic-protocol-error", Message = "Synthetic protocol failure" };

        var events = await CollectAsync(
            Updates(new ChatResponseUpdate { RawRepresentation = supplied }), CreateContext(options));

        Assert.Equal(0, calls);
        Assert.Same(supplied, Assert.Single(events.OfType<RunErrorEvent>()));
        Assert.DoesNotContain(events, evt => evt is RunFinishedEvent);
    }

    [Fact]
    public async Task LastRegistration_ReplacesEarlierObserver()
    {
        var firstCalls = 0;
        var secondCalls = 0;
        var options = new AGUIStreamOptions().OnStreamingError((_, _) => firstCalls++);
        Assert.Same(options, options.OnStreamingError((_, _) => secondCalls++));

        await CollectAsync(ThrowingUpdates(CreateFailure()), CreateContext(options));

        Assert.Equal(0, firstCalls);
        Assert.Equal(1, secondCalls);
    }

    [Fact]
    public async Task SharedOptions_ReportEachConcurrentRequestsExceptionAndContext()
    {
        var observed = new ConcurrentQueue<(Exception Error, ChatRequestContext Context)>();
        var options = new AGUIStreamOptions().OnStreamingError((exception, context) => observed.Enqueue((exception, context)));
        var firstContext = CreateContext(options, "synthetic-first-run");
        var secondContext = CreateContext(options, "synthetic-second-run");
        var firstFailure = CreateFailure();
        var secondFailure = CreateFailure();

        await Task.WhenAll(
            CollectAsync(ThrowingUpdates(firstFailure), firstContext),
            CollectAsync(ThrowingUpdates(secondFailure), secondContext));

        Assert.Equal(2, observed.Count);
        Assert.Contains(observed, item => ReferenceEquals(item.Error, firstFailure) && ReferenceEquals(item.Context, firstContext));
        Assert.Contains(observed, item => ReferenceEquals(item.Error, secondFailure) && ReferenceEquals(item.Context, secondContext));
    }

    [Fact]
    public void NullObserver_IsRejected()
    {
        var error = Assert.Throws<ArgumentNullException>(() => new AGUIStreamOptions().OnStreamingError(null!));

        Assert.Equal("observer", error.ParamName);
    }

    private static ChatRequestContext CreateContext(AGUIStreamOptions options, string runId = "synthetic-run") =>
        new RunAgentInput { ThreadId = "synthetic-thread", RunId = runId }
            .ToChatRequestContext(AIJsonUtilities.DefaultOptions, options);

    private static void AssertSanitized(RunErrorEvent error)
    {
        var json = JsonSerializer.SerializeToElement(error, AGUIJsonSerializerContext.Default.RunErrorEvent);
        Assert.Equal("RUN_ERROR", json.GetProperty("type").GetString());
        Assert.Equal("StreamingError", json.GetProperty("code").GetString());
        Assert.Equal("An error occurred while streaming the agent response.", json.GetProperty("message").GetString());
        Assert.Equal(new[] { "code", "message", "type", "usage" },
            json.EnumerateObject().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.Equal(7, json.GetProperty("usage")[0].GetProperty("inputTokens").GetInt64());
    }

    private static ActivityListener? Listen(string tracing, Action<Activity>? onStopped = null)
    {
        if (tracing == "none")
        {
            return null;
        }

        var listener = new ActivityListener
        {
            ShouldListenTo = source => source.Name == AGUIServerInstrumentation.ActivitySourceName,
            Sample = (ref ActivityCreationOptions<ActivityContext> _) =>
                tracing == "record" ? ActivitySamplingResult.AllDataAndRecorded : ActivitySamplingResult.None,
            ActivityStopped = activity => onStopped?.Invoke(activity),
        };
        ActivitySource.AddActivityListener(listener);
        return listener;
    }

    private static Exception CreateFailure()
    {
        try
        {
            throw new IOException("synthetic inner detail");
        }
        catch (IOException inner)
        {
            var failure = new InvalidOperationException("synthetic provider failure", inner);
            failure.Data["detail"] = "synthetic-sensitive-value";
            return failure;
        }
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ThrowingUpdates(
        Exception failure, bool yieldThread = true, Action? onDisposed = null)
    {
        try
        {
            yield return new ChatResponseUpdate(ChatRole.Assistant, "partial");
            yield return new ChatResponseUpdate
            {
                ModelId = "synthetic-model",
                Contents = [new UsageContent(new UsageDetails { InputTokenCount = 7 })],
            };
            if (yieldThread)
            {
                await Task.Yield();
            }

            throw failure;
        }
        finally
        {
            onDisposed?.Invoke();
        }
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> Updates(params ChatResponseUpdate[] updates)
    {
        foreach (var update in updates)
        {
            yield return update;
        }

        await Task.CompletedTask.ConfigureAwait(true);
    }

    private static async Task<List<BaseEvent>> CollectAsync(IAsyncEnumerable<ChatResponseUpdate> updates, ChatRequestContext context)
    {
        var events = new List<BaseEvent>();
        await foreach (var evt in updates.AsAGUIEventStreamAsync(context).ConfigureAwait(true))
        {
            events.Add(evt);
        }

        return events;
    }
}
