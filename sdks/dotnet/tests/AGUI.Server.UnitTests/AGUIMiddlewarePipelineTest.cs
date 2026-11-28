using System.Runtime.CompilerServices;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class AGUIMiddlewarePipelineTest
{
    [Fact]
    public void Build_WithoutMiddleware_ReturnsTerminal()
    {
        AGUIRunDelegate terminal = (input, ct) => Emit(Started(input));

        Assert.Same(terminal, new AGUIMiddlewarePipeline().Build(terminal));
    }

    [Fact]
    public async Task Build_FirstRegisteredMiddleware_IsOutermost()
    {
        var log = new List<string>();
        var pipeline = new AGUIMiddlewarePipeline()
            .Use(new RecordingMiddleware("a", log))
            .Use(new RecordingMiddleware("b", log));

        var run = pipeline.Build((input, ct) =>
        {
            log.Add("terminal");
            return Emit(Started(input));
        });

        await Collect(run(new RunAgentInput { ThreadId = "t", RunId = "r" }, default));

        Assert.Equal(["a:in", "b:in", "terminal", "b:event", "a:event"], log);
    }

    [Fact]
    public async Task Use_FunctionMiddleware_CanReplaceInputAndAddEvents()
    {
        var pipeline = new AGUIMiddlewarePipeline()
            .Use((input, next, ct) => Append(
                next(new RunAgentInput { ThreadId = input.ThreadId, RunId = "rewritten" }, ct),
                new CustomEvent { Name = "added" }));

        var run = pipeline.Build((input, ct) => Emit(Started(input)));
        var events = await Collect(run(new RunAgentInput { ThreadId = "t", RunId = "original" }, default));

        Assert.Collection(events,
            e => Assert.Equal("rewritten", Assert.IsType<RunStartedEvent>(e).RunId),
            e => Assert.Equal("added", Assert.IsType<CustomEvent>(e).Name));
    }

    [Fact]
    public async Task Build_IgnoresMiddlewareRegisteredAfterward()
    {
        var log = new List<string>();
        var pipeline = new AGUIMiddlewarePipeline().Use(new RecordingMiddleware("a", log));
        var run = pipeline.Build((input, ct) => Emit(Started(input)));

        pipeline.Use(new RecordingMiddleware("late", log));
        await Collect(run(new RunAgentInput(), default));

        Assert.Equal(["a:in", "a:event"], log);
        Assert.Equal(2, pipeline.Middlewares.Count);
    }

    [Fact]
    public void Use_Null_Throws()
    {
        var pipeline = new AGUIMiddlewarePipeline();

        Assert.Throws<ArgumentNullException>(() => pipeline.Use((AGUIMiddleware)null!));
        Assert.Throws<ArgumentNullException>(() => pipeline.Build(null!));
    }

    private static RunStartedEvent Started(RunAgentInput input) =>
        new() { ThreadId = input.ThreadId, RunId = input.RunId };

    private static async IAsyncEnumerable<BaseEvent> Emit(params BaseEvent[] events)
    {
        foreach (var evt in events)
        {
            yield return evt;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<BaseEvent> Append(IAsyncEnumerable<BaseEvent> events, BaseEvent extra)
    {
        await foreach (var evt in events.ConfigureAwait(false))
        {
            yield return evt;
        }

        yield return extra;
    }

    private static async Task<List<BaseEvent>> Collect(IAsyncEnumerable<BaseEvent> events)
    {
        var list = new List<BaseEvent>();
        await foreach (var evt in events.ConfigureAwait(false))
        {
            list.Add(evt);
        }

        return list;
    }

    private sealed class RecordingMiddleware(string name, List<string> log) : AGUIMiddleware
    {
        public override async IAsyncEnumerable<BaseEvent> RunAsync(
            RunAgentInput input,
            AGUIRunDelegate next,
            [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            log.Add($"{name}:in");
            await foreach (var evt in next(input, cancellationToken).ConfigureAwait(false))
            {
                log.Add($"{name}:event");
                yield return evt;
            }
        }
    }
}
