using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public partial class ManagedAgentsRecoveryTest
{
    [Theory]
    [InlineData("ts")]
    [InlineData("py")]
    [InlineData("dotnet")]
    public async Task CapturedChildResultSurvivesColdApprovalAndRestart(string language)
    {
        using var fixture = JsonDocument.Parse(await File.ReadAllTextAsync(Path.Combine(AppContext.BaseDirectory, "child-results.json")));
        var row = fixture.RootElement.GetProperty(language);
        var root = row.GetProperty("root").EnumerateArray().Select(e => e.Clone()).ToList();
        var native = row.GetProperty("native").EnumerateArray().Select(e => e.Clone()).ToList();
        var call = root[0];
        var thread = call.GetProperty("session_thread_id").GetString()!;
        var callId = call.GetProperty("id").GetString()!;
        var result = native.Single(e => e.GetProperty("type").GetString() == "agent.tool_result");
        var store = new InMemorySessionStore();
        var fake = new FakeManagedAgentsClient([root[1].GetRawText(), Idle]) { History = [call] };
        fake.ChildHistories[thread] = [.. native, result];
        var input = Input();
        input.Resume = [new AGUIResume { InterruptId = callId, Status = "resolved", Payload = root[1].GetProperty("result") }];
        var events = await Collect(Agent(fake, store, baseline: "old"), input);
        var emitted = Assert.Single(events.OfType<ToolCallResultEvent>());
        Assert.Equal(callId, emitted.ToolCallId);
        Assert.Equal(result.GetProperty("id").GetString(), emitted.MessageId);
        var emittedText = Assert.IsType<AGUITextInputContent>(Assert.Single(emitted.Content)).Text;
        if (result.GetProperty("is_error").GetBoolean())
        {
            using var envelope = JsonDocument.Parse(emittedText);
            Assert.True(envelope.RootElement.GetProperty("error").GetBoolean());
            emittedText = envelope.RootElement.GetProperty("content").GetString()!;
        }
        Assert.Equal(result.GetProperty("content")[0].GetProperty("text").GetString()!, emittedText);
        Assert.Contains(events.OfType<RawEvent>(), e => e.Event is JsonElement raw && raw.GetProperty("id").GetString() == emitted.MessageId && raw.GetProperty("session_thread_id").GetString() == thread && raw.GetProperty("is_error").GetBoolean() == result.GetProperty("is_error").GetBoolean());
        var restarted = new FakeManagedAgentsClient { History = [.. root, FakeManagedAgentsClient.Json(Idle), result] };
        restarted.ChildHistories[thread] = native;
        var replay = await Collect(Agent(restarted, store, baseline: "old"), Input());
        Assert.Empty(replay.OfType<ToolCallResultEvent>());
        Assert.IsType<RunFinishedEvent>(replay[^1]);
    }

    [Fact]
    public async Task ChildResultRequiresExactCallAndScope()
    {
        var call = FakeManagedAgentsClient.Json("""{"id":"call","type":"agent.tool_use","session_thread_id":"child","name":"write","evaluated_permission":"ask"}""");
        var fake = new FakeManagedAgentsClient { History = [call, FakeManagedAgentsClient.Json(Idle)] };
        fake.ChildHistories["child"] = [
            FakeManagedAgentsClient.Json("""{"id":"wrong-call","type":"agent.tool_result","tool_use_id":"other","content":[]}"""),
            FakeManagedAgentsClient.Json("""{"id":"wrong-scope","type":"agent.tool_result","tool_use_id":"call","session_thread_id":"other","content":[]}"""),
            FakeManagedAgentsClient.Json("""{"id":"confirmation","type":"user.tool_confirmation","tool_use_id":"call","result":"allow"}"""),
            FakeManagedAgentsClient.Json("""{"id":"prose","type":"agent.message","content":[{"type":"text","text":"Done!"}]}""")];
        var path = Path.Combine(Path.GetTempPath(), $"child-results-{Guid.NewGuid()}.json");
        try
        {
            var events = await Collect(Agent(fake, new DiskStore(path)), Input());
            Assert.Empty(events.OfType<ToolCallResultEvent>());
            Assert.IsType<RunFinishedEvent>(events[^1]);
            fake.ChildHistories["child"] = [FakeManagedAgentsClient.Json("""{"id":"late-result","type":"agent.tool_result","tool_use_id":"call","content":[{"type":"text","text":"exact result"}]}""")];
            var reloaded = await Collect(Agent(fake, new DiskStore(path)), Input());
            Assert.Equal("exact result", Assert.IsType<AGUITextInputContent>(Assert.Single(Assert.Single(reloaded.OfType<ToolCallResultEvent>()).Content)).Text);
            Assert.Empty((await Collect(Agent(fake, new DiskStore(path)), Input())).OfType<ToolCallResultEvent>());
        }
        finally { File.Delete(path); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InitialChildResultIsRecoveredBeforeFinishAndNotReplayed(bool crossPosted)
    {
        var call = FakeManagedAgentsClient.Json("""{"id":"initial-call","type":"agent.tool_use","session_thread_id":"child","name":"write","input":{},"evaluated_permission":"ask"}""");
        var result = FakeManagedAgentsClient.Json("""{"id":"initial-result","type":"agent.tool_result","tool_use_id":"initial-call","content":[{"type":"text","text":"done"}]}""");
        var store = new RecordingSessionStore();
        var stream = new List<string> { call.GetRawText() };
        if (crossPosted) stream.Add(result.GetRawText());
        stream.Add(Idle);
        var fake = new FakeManagedAgentsClient(stream);
        fake.ChildHistories["child"] = [result];
        var initial = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = store, ToolConfirmation = ToolConfirmationPolicy.Allow });
        var events = await Collect(initial, Input());
        Assert.Single(events.OfType<ToolCallResultEvent>());
        Assert.IsType<RunFinishedEvent>(events[^1]);
        var restarted = new FakeManagedAgentsClient { History = [call, FakeManagedAgentsClient.Json(Idle)] };
        restarted.ChildHistories["child"] = [result];
        var input = Input(); input.Messages = [];
        var replay = await Collect(Agent(restarted, store), input);
        Assert.IsType<RunFinishedEvent>(replay[^1]);
        Assert.Empty(replay.OfType<ToolCallResultEvent>());
    }

    [Fact]
    public async Task TranscriptKnownChildResultRemainsDeliveredWithoutTranscript()
    {
        var call = FakeManagedAgentsClient.Json("""{"id":"known-call","type":"agent.tool_use","session_thread_id":"child","name":"write","input":{},"evaluated_permission":"ask"}""");
        var result = FakeManagedAgentsClient.Json("""{"id":"known-result","type":"agent.tool_result","tool_use_id":"known-call","content":[{"type":"text","text":"done"}]}""");
        var store = new RecordingSessionStore();
        var fake = new FakeManagedAgentsClient { History = [call, FakeManagedAgentsClient.Json(Idle)] };
        fake.ChildHistories["child"] = [result];
        var input = Input(); input.Messages = [new AGUIToolMessage { Id = "known-result", ToolCallId = "known-call", Content = "done" }];
        Assert.Empty((await Collect(Agent(fake, store), input)).OfType<ToolCallResultEvent>());
        input.Messages = [];
        var replay = await Collect(Agent(fake, store), input);
        Assert.IsType<RunFinishedEvent>(replay[^1]);
        Assert.Empty(replay.OfType<ToolCallResultEvent>());
    }

    private const string Idle = """{"type":"session.status_idle","id":"done","stop_reason":{"type":"end_turn"}}""";
    private static JsonElement Call(string id, bool confirmation = false) => FakeManagedAgentsClient.Json(
        $$"""{"id":"{{id}}","type":"{{(confirmation ? "agent.tool_use" : "agent.custom_tool_use")}}","name":"lookup","input":{},"evaluated_permission":"ask"}""");
    private static RunAgentInput Input() => new() { ThreadId = "thread", RunId = "run", Messages = [new AGUIUserMessage { Id = "old", Content = "history" }], Tools = [] };
    private static ManagedAgentsAgent Agent(FakeManagedAgentsClient client, ISessionStore? store = null, string? baseline = null, string? child = null) => new(new()
    {
        ManagedAgentId = "agent", EnvironmentId = "env", Client = client, SessionStore = store,
        ResolveSession = (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(new() { SessionId = "native", LastUserMessageId = baseline, SessionThreadId = child }),
    });
    private static async Task<List<BaseEvent>> Collect(ManagedAgentsAgent agent, RunAgentInput input, CancellationToken cancellationToken = default)
    {
        var result = new List<BaseEvent>();
        await foreach (var evt in agent.RunAsync(input, cancellationToken)) result.Add(evt);
        return result;
    }

    [Fact]
    public async Task RestartAdoptsWithoutReplayingHistoryOrReplacingTools()
    {
        var fake = new FakeManagedAgentsClient { History = [Call("custom"), Call("approval", true)] };
        var events = await Collect(Agent(fake), Input());
        Assert.Equal(new[] { "stream", "history" }, fake.RecoveryOrder);
        Assert.Empty(fake.CreatedSessions); Assert.Empty(fake.Updates); Assert.Empty(fake.Sent);
        Assert.Equal(new[] { "custom", "approval" }, events.OfType<ToolCallStartEvent>().Select(e => e.ToolCallId));
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(events[^1]).Outcome);
        var approval = Assert.Single(outcome.Interrupts);
        Assert.Equal("approval", approval.Id); Assert.Equal("approval", approval.ToolCallId); Assert.Equal("tool-approval", approval.Reason);
        Assert.Equal("allow", approval.ResponseSchema!.Value.GetProperty("enum")[0].GetString());
    }

    [Fact]
    public async Task PartialAnswersKeepOtherRequestsAndDoNotSendUserFollowup()
    {
        var fake = new FakeManagedAgentsClient { History = [Call("c1"), Call("c2"), Call("a1", true), Call("a2", true)] };
        var input = Input();
        input.Messages!.Add(new AGUIToolMessage { Id = "result", ToolCallId = "c1", Content = "answer" });
        input.Messages.Add(new AGUIUserMessage { Id = "new", Content = "followup" });
        input.Resume = [new AGUIResume { InterruptId = "a1", Status = "cancelled" }];
        var events = await Collect(Agent(fake, baseline: "old"), input);
        Assert.Equal(new[] { "user.tool_confirmation", "user.custom_tool_result" }, fake.SentTypes);
        Assert.Equal("deny", fake.Sent[0][0].GetProperty("result").GetString());
        Assert.Equal(new[] { "c2", "a2" }, events.OfType<ToolCallStartEvent>().Select(e => e.ToolCallId));
    }

    [Theory]
    [InlineData("unknown", "allow")]
    [InlineData("approval", "yes")]
    public async Task InvalidResumeBatchHasNoRemoteSideEffects(string id, string answer)
    {
        var fake = new FakeManagedAgentsClient { History = [Call("approval", true)] };
        var input = Input(); input.Resume = [new AGUIResume { InterruptId = id, Payload = JsonSerializer.SerializeToElement(answer) }];
        var events = await Collect(Agent(fake), input);
        Assert.Equal("invalid_resume", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent); Assert.Empty(fake.Updates);
    }

    [Fact]
    public async Task PostedHistoryResultsAreSubtractedAndLiveDuplicatesIgnored()
    {
        var duplicate = """{"type":"agent.message","id":"historical","content":[{"type":"text","text":"past"}]}""";
        var fake = new FakeManagedAgentsClient([duplicate, Idle]) { History = [Call("answered"), FakeManagedAgentsClient.Json("""{"id":"result","type":"user.custom_tool_result","custom_tool_use_id":"answered"}"""), FakeManagedAgentsClient.Json(duplicate)] };
        var input = Input(); input.Messages!.Add(new AGUIUserMessage { Id = "next", Content = "continue" });
        var events = await Collect(Agent(fake, baseline: "old"), input);
        Assert.Single(fake.SentEvents); Assert.Empty(events.OfType<TextMessageContentEvent>()); Assert.Empty(events.OfType<ToolCallStartEvent>());
        Assert.IsType<RunFinishedEvent>(events[^1]);
    }

    [Fact]
    public async Task ChildBindingRejectsUserMessagesWithoutSendingToParent()
    {
        var fake = new FakeManagedAgentsClient();
        var input = Input(); input.Messages!.Add(new AGUIUserMessage { Id = "next", Content = "continue" });
        var events = await Collect(Agent(fake, baseline: "old", child: "child"), input);
        Assert.Equal("child", fake.RequestedThreadId); Assert.Empty(fake.Sent);
        Assert.Equal("child_thread_message_unsupported", Assert.IsType<RunErrorEvent>(events[^1]).Code);
    }

    [Fact]
    public async Task TerminatedBindingRemainsATombstone()
    {
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_terminated","id":"end"}""")] };
        var store = new InMemorySessionStore();
        var first = await Collect(Agent(fake, store), Input());
        var second = await Collect(Agent(fake, store), Input());
        Assert.Equal("session_terminated", Assert.IsType<RunErrorEvent>(first[^1]).Code);
        Assert.Equal("session_terminated", Assert.IsType<RunErrorEvent>(second[^1]).Code);
        Assert.Empty(fake.CreatedSessions); Assert.Single(fake.StreamRequests);
    }
    [Fact]
    public async Task DiskStoreRestartReplaysOnlyActivityAfterDurableCursor()
    {
        var path = Path.Combine(Path.GetTempPath(), $"agui-recovery-{Guid.NewGuid()}.json");
        try
        {
            var old = FakeManagedAgentsClient.Json(Idle);
            await Collect(Agent(new FakeManagedAgentsClient { History = [old] }, new DiskStore(path)), Input());
            var missed = FakeManagedAgentsClient.Json("""{"type":"agent.message","id":"offline","content":[{"type":"text","text":"Completed offline"}]}""");
            var fake = new FakeManagedAgentsClient { History = [old, missed] };
            var events = await Collect(Agent(fake, new DiskStore(path)), Input());
            Assert.Equal("Completed offline", Assert.Single(events.OfType<TextMessageContentEvent>()).Delta);
            Assert.Empty(fake.Sent); Assert.Empty(fake.CreatedSessions);
            var again = await Collect(Agent(fake, new DiskStore(path)), Input());
            Assert.Empty(again.OfType<TextMessageContentEvent>());
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public async Task MissingBlockingRequestFailsWithoutSendingOrInterrupting()
    {
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_idle","id":"idle","stop_reason":{"type":"requires_action","event_ids":["missing"]}}""")] };
        var events = await Collect(Agent(fake), Input());
        Assert.Equal("session_unavailable", Assert.IsType<RunErrorEvent>(events[^1]).Code); Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task EndTurnClearsHistoricalUnansweredRequests()
    {
        var fake = new FakeManagedAgentsClient { History = [Call("stale"), FakeManagedAgentsClient.Json(Idle)] };
        var events = await Collect(Agent(fake), Input());
        Assert.Empty(events.OfType<ToolCallStartEvent>()); Assert.Empty(fake.Sent);
    }

    private sealed class DiskStore(string path) : ISessionStore
    {
        public async ValueTask<ManagedAgentsSessionRecord?> GetAsync(string key, CancellationToken cancellationToken)
            => File.Exists(path) ? JsonSerializer.Deserialize<ManagedAgentsSessionRecord>(await File.ReadAllTextAsync(path, cancellationToken)) : null;
        public async ValueTask SetAsync(string key, ManagedAgentsSessionRecord record, CancellationToken cancellationToken)
            => await File.WriteAllTextAsync(path, JsonSerializer.Serialize(record), cancellationToken);
        public ValueTask DeleteAsync(string key, CancellationToken cancellationToken) { File.Delete(path); return default; }
    }
    [Fact]
    public async Task RecoveredBackendCallIsNeverExecuted()
    {
        var invoked = false;
        var fake = new FakeManagedAgentsClient { History = [Call("backend")] };
        var agent = new ManagedAgentsAgent(new()
        {
            ManagedAgentId = "agent", EnvironmentId = "env", Client = fake,
            ResolveSession = (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(new() { SessionId = "native" }),
            BackendTools = { new ManagedAgentsBackendTool { Name = "lookup", Handler = _ => { invoked = true; return Task.FromResult("bad"); } } },
        });
        var events = await Collect(agent, Input());
        Assert.False(invoked); Assert.Equal("backend", Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallId); Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task OwnedSessionWithNoCursorReplaysActivityAfterCrash()
    {
        var store = new RecordingSessionStore();
        await store.SetAsync("5:agent|0:|3:env|0:|thread", new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old" }, default);
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"agent.message","id":"offline","content":[{"type":"text","text":"Completed after crash"}]}"""), FakeManagedAgentsClient.Json(Idle)] };
        var events = await Collect(Agent(fake, store), Input());
        Assert.Equal("Completed after crash", Assert.Single(events.OfType<TextMessageContentEvent>()).Delta); Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task RunningHistoryContinuesOnTheAlreadyOpenedStreamWithoutInput()
    {
        var fake = new FakeManagedAgentsClient([Idle]) { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"running"}""")] };
        var events = await Collect(Agent(fake), Input());
        Assert.IsType<RunFinishedEvent>(events[^1]); Assert.Single(fake.StreamRequests); Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task UnknownLiveNativeCustomToolRemainsPendingWithoutAutomaticErrorResult()
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"agent.custom_tool_use","id":"native-call","name":"native-only","input":{}}""",
            """{"type":"session.status_idle","id":"park","stop_reason":{"type":"requires_action","event_ids":["native-call"]}}"""])
        { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"running"}""")] };
        var events = await Collect(Agent(fake), Input());
        Assert.IsType<RunFinishedEvent>(events[^1]); Assert.Empty(fake.Sent);
        Assert.Equal("native-call", Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallId);
    }
    [Fact]
    public async Task MissedCompletedCustomCallReplaysLifecycleWithoutExecuting()
    {
        var store = new RecordingSessionStore();
        await store.SetAsync("5:agent|0:|3:env|0:|thread", new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old", LastEventId = "boundary", PreserveTools = true }, default);
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"boundary"}"""), Call("offline-call"),
            FakeManagedAgentsClient.Json("""{"type":"user.custom_tool_result","id":"offline-result","custom_tool_use_id":"offline-call","content":[{"type":"text","text":"answer"}]}"""), FakeManagedAgentsClient.Json(Idle)] };
        var events = await Collect(Agent(fake, store), Input());
        Assert.Equal("offline-call", Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallId);
        Assert.Single(events.OfType<ToolCallArgsEvent>()); Assert.Single(events.OfType<ToolCallEndEvent>());
        var result = Assert.Single(events.OfType<ToolCallResultEvent>());
        Assert.Equal("offline-call", result.ToolCallId); Assert.Equal("tool", result.Role); Assert.Equal("answer", result.Content.ToString());
        Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task CrossPostedApprovalMetadataRetainsItsOriginalChildThread()
    {
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"agent.tool_use","id":"approval","name":"bash","input":{},"evaluated_permission":"ask","session_thread_id":"native-child"}""")] };
        var events = await Collect(Agent(fake), Input());
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(events[^1]).Outcome);
        var metadata = Assert.Single(outcome.Interrupts).Metadata!.Value;
        Assert.Equal("native", metadata.GetProperty("sessionId").GetString());
        Assert.Equal("native-child", metadata.GetProperty("sessionThreadId").GetString());
        Assert.Equal("bash", metadata.GetProperty("toolName").GetString());
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AlreadyRenderedToolCallDoesNotAppendItsArgumentsAgain(bool completed)
    {
        var store = new RecordingSessionStore();
        await store.SetAsync("5:agent|0:|3:env|0:|thread", new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old", LastEventId = "boundary", PreserveTools = true }, default);
        var history = new List<JsonElement> { FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"boundary"}"""), Call("known") };
        if (completed)
        {
            history.Add(FakeManagedAgentsClient.Json("""{"type":"user.custom_tool_result","id":"result","custom_tool_use_id":"known","content":[{"type":"text","text":"done"}]}"""));
            history.Add(FakeManagedAgentsClient.Json(Idle));
        }
        var fake = new FakeManagedAgentsClient { History = history };
        var input = Input();
        input.Messages!.Add(new AGUIAssistantMessage { Id = "assistant", ToolCalls = [new AGUIToolCall { Id = "known", Function = new() { Name = "lookup", Arguments = "{}" } }] });
        var events = await Collect(Agent(fake, store), input);
        Assert.Empty(events.OfType<ToolCallStartEvent>()); Assert.Empty(events.OfType<ToolCallArgsEvent>()); Assert.Empty(events.OfType<ToolCallEndEvent>());
        Assert.IsType<RunFinishedEvent>(events[^1]); Assert.Empty(fake.Sent);
        if (completed) Assert.Single(events.OfType<ToolCallResultEvent>());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RecoveredCustomCallsUseTheOriginalFrontendToolName(bool completed)
    {
        var store = new RecordingSessionStore();
        await store.SetAsync("5:agent|0:|3:env|0:|thread", new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old", PreserveTools = false }, default);
        var history = new List<JsonElement> { FakeManagedAgentsClient.Json("""{"type":"agent.custom_tool_use","id":"chart","name":"show_chart","input":{}}""") };
        if (completed)
        {
            history.Add(FakeManagedAgentsClient.Json("""{"type":"user.custom_tool_result","id":"result","custom_tool_use_id":"chart","content":[]}"""));
            history.Add(FakeManagedAgentsClient.Json(Idle));
        }
        var fake = new FakeManagedAgentsClient { History = history };
        var input = Input(); input.Tools = [new AGUITool { Name = "show chart", Description = "Display a chart" }];
        var events = await Collect(Agent(fake, store), input);
        Assert.Equal("show chart", Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallName);
        Assert.Single(events.OfType<ToolCallArgsEvent>()); Assert.Empty(fake.Sent);
    }
    [Fact]
    public async Task FreshNativeApprovalPersistsAndAcceptsExplicitAllowAfterRestart()
    {
        var path = Path.Combine(Path.GetTempPath(), $"agui-fresh-approval-{Guid.NewGuid()}.json");
        try
        {
            var fake = new FakeManagedAgentsClient([
                """{"type":"agent.tool_use","id":"fresh-approval","name":"bash","input":{},"evaluated_permission":"ask"}""",
                """{"type":"session.status_idle","id":"park","stop_reason":{"type":"requires_action","event_ids":["fresh-approval"]}}"""], [Idle]) { SessionId = "native" };
            var fresh = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = new DiskStore(path) });
            var first = await Collect(fresh, Input());
            var outcome = Assert.IsType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(first[^1]).Outcome);
            Assert.Equal("fresh-approval", Assert.Single(outcome.Interrupts).Id);
            Assert.Equal(new[] { "fresh-approval" }, (await new DiskStore(path).GetAsync("unused", default))!.PendingConfirmationIds);
            Assert.DoesNotContain("user.interrupt", fake.SentTypes);
            Assert.DoesNotContain("user.tool_confirmation", fake.SentTypes);
            var input = Input();
            input.Resume = [new AGUIResume { InterruptId = "fresh-approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement("allow") }];
            var second = await Collect(Agent(fake, new DiskStore(path)), input);
            Assert.IsType<RunFinishedEvent>(second[^1]);
            var confirmation = Assert.Single(fake.SentEvents, evt => evt.GetProperty("type").GetString() == "user.tool_confirmation");
            Assert.Equal("allow", confirmation.GetProperty("result").GetString());
            Assert.Equal("fresh-approval", confirmation.GetProperty("tool_use_id").GetString());
            Assert.Empty((await new DiskStore(path).GetAsync("unused", default))!.PendingConfirmationIds);
            Assert.Single(fake.CreatedSessions);
        }
        finally { File.Delete(path); }
    }
    [Theory]
    [InlineData("agent.tool_result", "tool_use_id")]
    [InlineData("agent.mcp_tool_result", "mcp_tool_use_id")]
    [InlineData("user.custom_tool_result", "custom_tool_use_id")]
    public async Task RichRecoveredResultsPreserveNativeIdentityContentAndOneRaw(string kind, string field)
    {
        var store = new InMemorySessionStore();
        var old = FakeManagedAgentsClient.Json(Idle);
        await Collect(Agent(new FakeManagedAgentsClient { History = [old] }, store), Input());
        var content = new object[] { new { type = "text", text = "  " + new string('x', 30000) + "\n" }, new { type = "image", source = new { type = "base64", data = "AAEC", media_type = "image/png" } } };
        var native = JsonSerializer.SerializeToElement(new Dictionary<string, object> { ["type"] = kind, ["id"] = "native-result", [field] = "native-call", ["is_error"] = true, ["content"] = content });
        var fake = new FakeManagedAgentsClient { History = [old, native] };
        var events = await Collect(Agent(fake, store), Input());
        var raw = Assert.Single(events.OfType<RawEvent>(), e => e.Event.GetProperty("id").GetString() == "native-result");
        Assert.Equal("claude-managed-agents", raw.Source);
        Assert.True(JsonElement.DeepEquals(native, raw.Event));
        var result = Assert.Single(events.OfType<ToolCallResultEvent>());
        Assert.Equal("native-result", result.MessageId); Assert.Equal("native-call", result.ToolCallId);
        Assert.All(result.Content, p => Assert.True((p is AGUIMediaInputContent media ? media.Metadata : ((AGUITextInputContent)p).Metadata)!.Value.GetProperty("isError").GetBoolean()));
        var preserved = result.Content.Select(p => (p is AGUIMediaInputContent media ? media.Metadata : ((AGUITextInputContent)p).Metadata)!.Value.GetProperty("claudeManagedAgents")).ToArray();
        Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(content), JsonSerializer.SerializeToElement(preserved)));
        Assert.Empty(fake.Sent);
    }
}
