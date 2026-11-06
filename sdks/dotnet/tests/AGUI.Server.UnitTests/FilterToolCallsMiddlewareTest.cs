using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

public sealed class FilterToolCallsMiddlewareTest
{
    private const string Hidden = "lookup_customer_record";
    private const string Visible = "get_weather";

    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    #region Live stream

    [Fact]
    public async Task Disallow_DropsHiddenCallLifecycle_KeepsVisibleCallAndText()
    {
        var events = await RunConverted(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            Update(new FunctionCallContent("c-hidden", Hidden, new Dictionary<string, object?> { ["ssn"] = "123" })),
            Update(new FunctionResultContent("c-hidden", "secret-row")),
            Update(new FunctionCallContent("c-visible", Visible, new Dictionary<string, object?> { ["city"] = "Paris" })),
            Update(new FunctionResultContent("c-visible", "sunny")),
            Update(new TextContent("Done.")));

        Assert.DoesNotContain(events, e => MentionsCall(e, "c-hidden"));
        Assert.Contains(events, e => e is ToolCallStartEvent { ToolCallId: "c-visible" });
        Assert.Contains(events, e => e is ToolCallResultEvent { ToolCallId: "c-visible" });
        Assert.Contains(events, e => e is TextMessageContentEvent { Delta: "Done." });
        Assert.IsType<RunFinishedEvent>(events[^1]);
    }

    [Fact]
    public async Task Allow_HidesEveryUnlistedTool()
    {
        var events = await RunConverted(
            FilterToolCallsMiddleware.Allow([Visible]),
            Update(new FunctionCallContent("c-hidden", Hidden)),
            Update(new FunctionResultContent("c-hidden", "secret-row")),
            Update(new FunctionCallContent("c-visible", Visible)),
            Update(new FunctionResultContent("c-visible", "sunny")));

        Assert.DoesNotContain(events, e => MentionsCall(e, "c-hidden"));
        Assert.Contains(events, e => e is ToolCallEndEvent { ToolCallId: "c-visible" });
    }

    [Fact]
    public async Task HiddenCall_MappedResultProjectionStillEmitted()
    {
        var streamOptions = new AGUIStreamOptions().MapResultAsStateSnapshot(Hidden);
        var events = await RunConverted(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            streamOptions,
            Update(new FunctionCallContent("c-hidden", Hidden)),
            Update(new FunctionResultContent("c-hidden", Json("""{"tier":"gold"}"""))));

        Assert.DoesNotContain(events, e => MentionsCall(e, "c-hidden"));
        var snapshot = Assert.Single(events.OfType<StateSnapshotEvent>());
        Assert.Equal("gold", snapshot.Snapshot.GetProperty("tier").GetString());
    }

    [Fact]
    public async Task ToolCallChunks_HiddenCallDropped_IncludingContinuationChunksWithoutId()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new RunStartedEvent { ThreadId = "t", RunId = "r" },
            new ToolCallChunkEvent { ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{\"ssn\":" },
            new ToolCallChunkEvent { Delta = "\"123\"}" },
            new ToolCallChunkEvent { ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { Delta = "}" },
            new ToolCallChunkEvent { ToolCallId = "c-hidden", Delta = "late" });

        Assert.Collection(events,
            e => Assert.IsType<RunStartedEvent>(e),
            e => Assert.Equal("c-visible", Assert.IsType<ToolCallChunkEvent>(e).ToolCallId),
            e => Assert.Equal("}", Assert.IsType<ToolCallChunkEvent>(e).Delta));
    }

    [Fact]
    public async Task RunStarted_ResetsHiddenIds_SoAReusedIdOnAVisibleToolPasses()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new RunStartedEvent { ThreadId = "t", RunId = "r1" },
            new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = Hidden },
            new RunStartedEvent { ThreadId = "t", RunId = "r2" },
            new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = Visible },
            new ToolCallEndEvent { ToolCallId = "c1" });

        Assert.Equal(2, events.OfType<RunStartedEvent>().Count());
        Assert.Equal(Visible, Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallName);
        Assert.Single(events.OfType<ToolCallEndEvent>());
    }

    [Fact]
    public async Task ConcurrentRuns_DoNotShareHiddenIds()
    {
        var middleware = FilterToolCallsMiddleware.Disallow([Hidden]);
        var first = middleware.RunAsync(new RunAgentInput(), (_, _) => Emit(
            new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = Hidden },
            new ToolCallEndEvent { ToolCallId = "c1" }), default);
        var second = middleware.RunAsync(new RunAgentInput(), (_, _) => Emit(
            new ToolCallStartEvent { ToolCallId = "c1", ToolCallName = Visible },
            new ToolCallEndEvent { ToolCallId = "c1" }), default);

        var a = first.GetAsyncEnumerator();
        var b = second.GetAsyncEnumerator();
        try
        {
            Assert.False(await a.MoveNextAsync());
            Assert.True(await b.MoveNextAsync());
            Assert.IsType<ToolCallStartEvent>(b.Current);
            Assert.True(await b.MoveNextAsync());
            Assert.IsType<ToolCallEndEvent>(b.Current);
        }
        finally
        {
            await a.DisposeAsync();
            await b.DisposeAsync();
        }
    }

    [Fact]
    public async Task Continuation_ReplayedResultOfHiddenCallFromHistory_IsDropped()
    {
        var input = new RunAgentInput
        {
            ThreadId = "t",
            RunId = "r",
            Messages =
            [
                new AGUIAssistantMessage { Id = "a1", ToolCalls = [ToolCall("c-hidden", Hidden)] },
            ],
        };

        var events = await Collect(FilterToolCallsMiddleware.Disallow([Hidden]).RunAsync(
            input,
            (_, _) => Emit(
                new RunStartedEvent { ThreadId = "t", RunId = "r" },
                new ToolCallResultEvent { ToolCallId = "c-hidden", MessageId = "c-hidden", Content = "secret-row" },
                new RunFinishedEvent { ThreadId = "t", RunId = "r" }),
            default));

        Assert.DoesNotContain(events, e => e is ToolCallResultEvent);
        Assert.Equal(2, events.Count);
    }

    [Fact]
    public async Task ToolCallChunks_ContinuationsAreTrackedPerSubagent()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { SubagentRunId = "a", ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { SubagentRunId = "b", ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { SubagentRunId = "a", Delta = "\"ssn\":\"123\"}" },
            new ToolCallChunkEvent { SubagentRunId = "b", Delta = "}" });

        Assert.Collection(events,
            e => Assert.Equal("c-visible", Assert.IsType<ToolCallChunkEvent>(e).ToolCallId),
            e => Assert.Equal("}", Assert.IsType<ToolCallChunkEvent>(e).Delta));
    }

    [Fact]
    public async Task ToolCallChunks_UntaggedContinuationFollowsTheLatestStream()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { SubagentRunId = "a", ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" });

        Assert.Empty(events);
    }

    [Fact]
    public async Task ToolCallChunks_UntaggedContinuationPrefersTheParentLane()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { SubagentRunId = "b", ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" },
            new ToolCallChunkEvent { SubagentRunId = "b", Delta = "}" });

        Assert.Collection(events,
            e => Assert.Equal("c-visible", Assert.IsType<ToolCallChunkEvent>(e).ToolCallId),
            e => Assert.Equal("}", Assert.IsType<ToolCallChunkEvent>(e).Delta));
    }

    [Fact]
    public async Task ToolCallChunks_AmbiguousUntaggedContinuationIsDropped()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { SubagentRunId = "a", ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { SubagentRunId = "b", ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" });

        Assert.Equal("c-visible", Assert.IsType<ToolCallChunkEvent>(Assert.Single(events)).ToolCallId);
    }

    [Fact]
    public async Task ToolCallChunks_ParentEventClosesTheParentLane()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new TextMessageStartEvent { MessageId = "m1" },
            new ToolCallChunkEvent { SubagentRunId = "a", ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" });

        Assert.Collection(events,
            e => Assert.IsType<ToolCallChunkEvent>(e),
            e => Assert.IsType<TextMessageStartEvent>(e));
    }

    [Fact]
    public async Task ToolCallChunks_TextChunkTakesOverItsLane()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new TextMessageChunkEvent { MessageId = "m1", Delta = "Hi" },
            new ToolCallChunkEvent { SubagentRunId = "a", ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" });

        Assert.Collection(events,
            e => Assert.IsType<ToolCallChunkEvent>(e),
            e => Assert.IsType<TextMessageChunkEvent>(e));
    }

    [Fact]
    public async Task ToolCallChunks_NothingHidden_StreamPassesThroughUntouched()
    {
        BaseEvent[] input =
        [
            new ToolCallChunkEvent { ToolCallId = "c1", ToolCallName = Visible, Delta = "{}" },
            new TextMessageChunkEvent { MessageId = "m1", Delta = "Hi" },
            new ToolCallChunkEvent { SubagentRunId = "b", ToolCallId = "c2", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { Delta = "}" },
        ];

        var events = await Run(FilterToolCallsMiddleware.Disallow([Hidden]), input);

        Assert.Equal(input, events);
    }

    [Fact]
    public async Task RunStarted_HiddenCallRevealedByItsRawDataStaysHidden()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new RunStartedEvent { ThreadId = "t", RunId = "r", RawEvent = Json($$$"""{"callId":"c1","name":"{{{Hidden}}}"}""") },
            new ToolCallResultEvent { ToolCallId = "c1", MessageId = "c1", Content = "secret-row" });

        Assert.Null(Assert.IsType<RunStartedEvent>(Assert.Single(events)).RawEvent);
    }

    [Fact]
    public async Task ToolCallChunks_ContinuationRepeatingAVisibleNameDoesNotReleaseAHiddenLane()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallChunkEvent { ToolCallId = "c-hidden", ToolCallName = Hidden, Delta = "{" },
            new ToolCallChunkEvent { SubagentRunId = "b", ToolCallId = "c-visible", ToolCallName = Visible, Delta = "{" },
            new ToolCallChunkEvent { ToolCallName = Visible, Delta = "}" },
            new ToolCallChunkEvent { Delta = "\"ssn\":\"123\"}" });

        Assert.Equal("c-visible", Assert.IsType<ToolCallChunkEvent>(Assert.Single(events)).ToolCallId);
    }

    [Fact]
    public async Task RunStarted_EchoedInputLosesHiddenHistory()
    {
        var started = new RunStartedEvent
        {
            ThreadId = "t",
            RunId = "r",
            Input = new RunAgentInput
            {
                ThreadId = "t",
                RunId = "r",
                Messages =
                [
                    new AGUIUserMessage { Id = "u1", Content = "Who am I?" },
                    new AGUIAssistantMessage { Id = "a1", ToolCalls = [ToolCall("c-hidden", Hidden)] },
                    new AGUIToolMessage { Id = "t1", ToolCallId = "c-hidden", Content = "secret-row" },
                ],
            },
        };

        var events = await Run(FilterToolCallsMiddleware.Disallow([Hidden]), started);

        var emitted = Assert.IsType<RunStartedEvent>(Assert.Single(events));
        Assert.Equal(["u1"], emitted.Input!.Messages.Select(m => m.Id));
        Assert.Equal(3, started.Input.Messages.Count);
    }

    #endregion

    #region Raw event data

    [Fact]
    public async Task TextEventFromUpdateCarryingHiddenCall_LosesRawEvent()
    {
        var events = await RunConverted(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            Update(
                new TextContent("Looking that up."),
                new FunctionCallContent("c-hidden", Hidden, new Dictionary<string, object?> { ["ssn"] = "123" })));

        var text = Assert.Single(events.OfType<TextMessageContentEvent>());
        Assert.Null(text.RawEvent);
        Assert.DoesNotContain(events, e => e.RawEvent is { } raw && raw.GetRawText().Contains("123", StringComparison.Ordinal));

        var json = JsonSerializer.Serialize<BaseEvent>(text, AGUIJsonSerializerContext.Default.BaseEvent);
        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("rawEvent", out _));
    }

    [Fact]
    public async Task TextEventFromUpdateCarryingHiddenResult_LosesRawEvent()
    {
        var events = await RunConverted(
            FilterToolCallsMiddleware.Allow([Visible]),
            Update(new FunctionCallContent("c-hidden", Hidden)),
            Update(new TextContent("Found it."), new FunctionResultContent("c-hidden", "secret-row")));

        var text = Assert.Single(events.OfType<TextMessageContentEvent>());
        Assert.Null(text.RawEvent);
    }

    [Fact]
    public async Task EventsUnrelatedToHiddenCalls_KeepRawEvent()
    {
        var events = await RunConverted(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            Update(new TextContent("Hi."), new FunctionCallContent("c-visible", Visible)));

        Assert.NotNull(Assert.Single(events.OfType<TextMessageContentEvent>()).RawEvent);
        Assert.NotNull(Assert.Single(events.OfType<ToolCallStartEvent>()).RawEvent);
    }

    [Fact]
    public async Task ScrubbedRawEvent_DoesNotMutateTheCallersEvent()
    {
        var original = new TextMessageContentEvent
        {
            MessageId = "m1",
            Delta = "hello",
            RawEvent = Json($$"""{"callId":"c9","name":"{{Hidden}}"}"""),
        };

        var events = await Run(FilterToolCallsMiddleware.Disallow([Hidden]), original);

        var emitted = Assert.IsType<TextMessageContentEvent>(Assert.Single(events));
        Assert.NotSame(original, emitted);
        Assert.Null(emitted.RawEvent);
        Assert.Equal("hello", emitted.Delta);
        Assert.NotNull(original.RawEvent);
    }

    [Fact]
    public async Task AllowList_BareNameWithoutCallId_IsNotTreatedAsATool()
    {
        var raw = Json("""{"author":{"name":"Alice"}}""");
        var events = await Run(
            FilterToolCallsMiddleware.Allow([Visible]),
            new TextMessageContentEvent { MessageId = "m1", Delta = "hi", RawEvent = raw });

        Assert.NotNull(Assert.Single(events).RawEvent);
    }

    [Fact]
    public async Task RawEventNamingHiddenTool_IsDropped()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new RawEvent { Event = Json($$$"""{"tool":{"name":"{{{Hidden}}}"}}""") },
            new RawEvent { Event = Json($$$"""{"tool":{"name":"{{{Visible}}}"}}""") });

        var kept = Assert.IsType<RawEvent>(Assert.Single(events));
        Assert.Contains(Visible, kept.Event.GetRawText(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task AllowList_ProviderNativeNestedFunctionName_IsRecognized()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Allow([Visible]),
            new RawEvent { Event = Json($$$"""{"tool_calls":[{"id":"c-hidden","function":{"name":"{{{Hidden}}}","arguments":"{}"}}]}""") },
            new ToolCallResultEvent { ToolCallId = "c-hidden", MessageId = "c-hidden", Content = "secret-row" });

        Assert.Empty(events);
    }

    [Fact]
    public async Task RawPayloadWithSeveralHiddenCalls_RegistersEveryCall()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new TextMessageContentEvent
            {
                MessageId = "m1",
                Delta = "hi",
                RawEvent = Json($$$"""{"contents":[{"callId":"c1","name":"{{{Hidden}}}"},{"callId":"c2","name":"{{{Hidden}}}"}]}"""),
            },
            new ToolCallResultEvent { ToolCallId = "c1", MessageId = "c1", Content = "secret-1" },
            new ToolCallResultEvent { ToolCallId = "c2", MessageId = "c2", Content = "secret-2" });

        var text = Assert.IsType<TextMessageContentEvent>(Assert.Single(events));
        Assert.Null(text.RawEvent);
    }

    [Fact]
    public async Task PascalCaseHostNaming_HiddenCallInMixedUpdateIsStillScrubbed()
    {
        var pascalCase = new JsonSerializerOptions(AIJsonUtilities.DefaultOptions) { PropertyNamingPolicy = null };
        var run = new AGUIMiddlewarePipeline()
            .Use(FilterToolCallsMiddleware.Disallow([Hidden]))
            .Build((input, ct) => EmitUpdates(
            [
                Update(
                    new TextContent("Looking that up."),
                    new FunctionCallContent("c-hidden", Hidden, new Dictionary<string, object?> { ["ssn"] = "123" })),
            ]).AsAGUIEventStreamAsync(input.ToChatRequestContext(pascalCase), ct));

        var events = await Collect(run(new RunAgentInput { ThreadId = "t", RunId = "r" }, default));

        Assert.Null(Assert.Single(events.OfType<TextMessageContentEvent>()).RawEvent);
        Assert.DoesNotContain(events, e => e.RawEvent is { } raw && raw.GetRawText().Contains("123", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ResultWhoseOwnRawDataRevealsTheHiddenCall_IsDropped()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallResultEvent
            {
                ToolCallId = "c1",
                MessageId = "c1",
                Content = "secret-row",
                RawEvent = Json($$$"""{"call-id":"c1","Name":"{{{Hidden}}}"}"""),
            });

        Assert.Empty(events);
    }

    [Fact]
    public async Task AllowList_UnrelatedIdAndNameObject_IsNotTreatedAsATool()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Allow([Visible]),
            new RawEvent { Event = Json("""{"user":{"id":"u1","name":"Alice"}}""") });

        Assert.IsType<RawEvent>(Assert.Single(events));
    }

    [Fact]
    public async Task AllowList_IdNameAndInputShape_IsRecognizedAsATool()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Allow([Visible]),
            new RawEvent { Event = Json($$$"""{"type":"tool_use","id":"c-hidden","name":"{{{Hidden}}}","input":{"ssn":"123"}}""") },
            new ToolCallResultEvent { ToolCallId = "c-hidden", MessageId = "c-hidden", Content = "secret-row" });

        Assert.Empty(events);
    }

    [Fact]
    public async Task ProviderItemId_ArgumentDeltasOfAHiddenCallAreDropped()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new RawEvent { Event = Json($$$"""{"type":"response.output_item.added","item":{"type":"function_call","id":"fc_1","call_id":"call_1","name":"{{{Hidden}}}","arguments":""}}""") },
            new RawEvent { Event = Json("""{"type":"response.function_call_arguments.delta","item_id":"fc_1","delta":"{\"ssn\":\"123\"}"}""") });

        Assert.Empty(events);
    }

    #endregion

    #region Messages snapshots

    [Fact]
    public async Task MessagesSnapshot_RemovesHiddenCallsAndTheirResults()
    {
        var original = new MessagesSnapshotEvent
        {
            Messages =
            [
                new AGUIUserMessage { Id = "u1", Content = "Who am I?" },
                new AGUIAssistantMessage
                {
                    Id = "a1",
                    ToolCalls = [ToolCall("c-hidden", Hidden)],
                },
                new AGUIToolMessage { Id = "t1", ToolCallId = "c-hidden", Content = "secret-row" },
                new AGUIAssistantMessage
                {
                    Id = "a2",
                    Content = "Checking the weather too.",
                    ToolCalls = [ToolCall("c-hidden-2", Hidden), ToolCall("c-visible", Visible)],
                },
                new AGUIToolMessage { Id = "t2", ToolCallId = "c-hidden-2", Content = "secret-row-2" },
                new AGUIToolMessage { Id = "t3", ToolCallId = "c-visible", Content = "sunny" },
                new AGUIAssistantMessage { Id = "a3", Content = "You are a gold customer." },
            ],
        };

        var events = await Run(FilterToolCallsMiddleware.Disallow([Hidden]), original);

        var snapshot = Assert.IsType<MessagesSnapshotEvent>(Assert.Single(events));
        Assert.Equal(["u1", "a2", "t3", "a3"], snapshot.Messages.Select(m => m.Id));
        var a2 = Assert.IsType<AGUIAssistantMessage>(snapshot.Messages[1]);
        Assert.Equal("c-visible", Assert.Single(a2.ToolCalls!).Id);

        // The caller's snapshot is left as it was.
        Assert.Equal(7, original.Messages.Count);
        Assert.Equal(2, ((AGUIAssistantMessage)original.Messages[3]).ToolCalls!.Count);
    }

    [Fact]
    public async Task MessagesSnapshot_RemovesResultsOfCallsHiddenEarlierInTheStream()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new ToolCallStartEvent { ToolCallId = "c-hidden", ToolCallName = Hidden },
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIToolMessage { Id = "t1", ToolCallId = "c-hidden", Content = "secret-row" }],
            });

        Assert.Empty(Assert.IsType<MessagesSnapshotEvent>(Assert.Single(events)).Messages);
    }

    [Fact]
    public async Task MessagesSnapshot_RawDataMentioningAHiddenCallOnlyByIdIsScrubbed()
    {
        var events = await Run(
            FilterToolCallsMiddleware.Disallow([Hidden]),
            new MessagesSnapshotEvent
            {
                Messages = [new AGUIAssistantMessage { Id = "a1", ToolCalls = [ToolCall("c-hidden", Hidden)] }],
                RawEvent = Json("""{"results":[{"callId":"c-hidden","result":"secret-row"}]}"""),
            });

        var snapshot = Assert.IsType<MessagesSnapshotEvent>(Assert.Single(events));
        Assert.Empty(snapshot.Messages);
        Assert.Null(snapshot.RawEvent);
    }

    [Fact]
    public async Task MessagesSnapshot_WithoutHiddenCalls_PassesThroughUnchanged()
    {
        var original = new MessagesSnapshotEvent
        {
            Messages = [new AGUIAssistantMessage { Id = "a1", ToolCalls = [ToolCall("c-visible", Visible)] }],
        };

        var events = await Run(FilterToolCallsMiddleware.Disallow([Hidden]), original);

        Assert.Same(original, Assert.Single(events));
    }

    #endregion

    [Fact]
    public void Factories_RejectNull()
    {
        Assert.Throws<ArgumentNullException>(() => FilterToolCallsMiddleware.Allow(null!));
        Assert.Throws<ArgumentNullException>(() => FilterToolCallsMiddleware.Disallow(null!));
    }

    private static JsonElement Json(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return doc.RootElement.Clone();
    }

    private static bool MentionsCall(BaseEvent evt, string callId) =>
        evt switch
        {
            ToolCallStartEvent e => e.ToolCallId == callId,
            ToolCallArgsEvent e => e.ToolCallId == callId,
            ToolCallEndEvent e => e.ToolCallId == callId,
            ToolCallResultEvent e => e.ToolCallId == callId,
            _ => evt.RawEvent is { } raw && raw.GetRawText().Contains(callId, StringComparison.Ordinal),
        };

    private static AGUIToolCall ToolCall(string id, string name) =>
        new() { Id = id, Function = new AGUIToolCallFunction { Name = name, Arguments = "{}" } };

    private static ChatResponseUpdate Update(params AIContent[] contents) =>
        new() { Role = ChatRole.Assistant, MessageId = "msg-1", Contents = [.. contents] };

    private static Task<List<BaseEvent>> RunConverted(FilterToolCallsMiddleware middleware, params ChatResponseUpdate[] updates) =>
        RunConverted(middleware, new AGUIStreamOptions(), updates);

    private static Task<List<BaseEvent>> RunConverted(
        FilterToolCallsMiddleware middleware,
        AGUIStreamOptions streamOptions,
        params ChatResponseUpdate[] updates)
    {
        var run = new AGUIMiddlewarePipeline()
            .Use(middleware)
            .Build((input, ct) => EmitUpdates(updates).AsAGUIEventStreamAsync(input.ToChatRequestContext(SerializerOptions, streamOptions), ct));

        return Collect(run(new RunAgentInput { ThreadId = "thread-1", RunId = "run-1" }, default));
    }

    private static Task<List<BaseEvent>> Run(FilterToolCallsMiddleware middleware, params BaseEvent[] events) =>
        Collect(middleware.RunAsync(new RunAgentInput(), (_, _) => Emit(events), default));

    private static async IAsyncEnumerable<ChatResponseUpdate> EmitUpdates(ChatResponseUpdate[] updates)
    {
        foreach (var update in updates)
        {
            yield return update;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<BaseEvent> Emit(params BaseEvent[] events)
    {
        foreach (var evt in events)
        {
            yield return evt;
        }

        await Task.CompletedTask.ConfigureAwait(false);
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
}
