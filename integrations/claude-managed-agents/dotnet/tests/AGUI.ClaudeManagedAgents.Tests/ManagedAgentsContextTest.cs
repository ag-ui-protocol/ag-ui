using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsContextTest
{
    private const string Idle = """{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}""";
    private const string Key = "1:a|0:|1:e|0:|t";
    private static List<AGUIContext> Context() => [new() { Description = "A2UI catalog", Value = "copilotkit://app-dashboard-catalog — FlightCard" }, new() { Description = "A2UI schema", Value = "  {\"component\":\"FlightCard\"}\n日本語" }];
    private static RunAgentInput Input(string id = "u1", IList<AGUIContext>? context = null) => new() { ThreadId = "t", RunId = "r", Tools = [], Context = context ?? Context(), Messages = [new AGUIUserMessage { Id = id, Content = "next" }] };
    private static ManagedAgentsAgent Agent(FakeManagedAgentsClient fake, ISessionStore? store = null, ManagedAgentsSessionBinding? binding = null) => new(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = fake, SessionStore = store, ResolveSession = binding is null ? null : (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(binding) });
    private static async Task<List<BaseEvent>> Collect(ManagedAgentsAgent agent, RunAgentInput input)
    {
        List<BaseEvent> events = [];
        await foreach (var evt in agent.RunAsync(input)) events.Add(evt);
        return events;
    }
    private static void AssertContext(IReadOnlyList<JsonElement> batch, IList<AGUIContext> expected)
    {
        Assert.Equal("system.message", batch[^1].GetProperty("type").GetString());
        var text = batch[^1].GetProperty("content")[0].GetProperty("text").GetString()!;
        Assert.True(JsonElement.DeepEquals(JsonSerializer.SerializeToElement(expected), JsonSerializer.Deserialize<JsonElement>(text[(text.IndexOf('\n') + 1)..])));
    }
    private static JsonElement Call(string id, bool confirmation = false) => JsonSerializer.SerializeToElement(new { id, type = confirmation ? "agent.tool_use" : "agent.custom_tool_use", name = "tool", input = new { }, evaluated_permission = "ask" });

    [Fact]
    public async Task ContextSurvivesColdStoreRestartAndClearsWithoutCrossThreadLeakage()
    {
        var fake = new FakeManagedAgentsClient(Enumerable.Range(1, 5).Select(i => (IReadOnlyList<string>)new[] { Idle.Replace("\"id\":\"idle\"", $"\"id\":\"idle_{i}\"", StringComparison.Ordinal) }).ToArray());
        var store = new InMemorySessionStore();
        Assert.IsType<RunFinishedEvent>((await Collect(Agent(fake, store), Input()))[^1]);
        AssertContext(fake.Sent[0], Context());
        var coldStore = new InMemorySessionStore();
        var saved = JsonSerializer.Serialize(await store.GetAsync(Key, default));
        await coldStore.SetAsync(Key, JsonSerializer.Deserialize<ManagedAgentsSessionRecord>(saved)!, default);
        var restored = Agent(fake, coldStore);
        Assert.IsType<RunFinishedEvent>((await Collect(restored, Input("u2")))[^1]);
        Assert.Single(fake.Sent[1]);
        var changed = new List<AGUIContext> { new() { Description = "catalog", Value = "updated" } };
        Assert.IsType<RunFinishedEvent>((await Collect(restored, Input("u3", changed)))[^1]);
        AssertContext(fake.Sent[2], changed);
        Assert.IsType<RunFinishedEvent>((await Collect(restored, Input("u4", [])))[^1]);
        AssertContext(fake.Sent[3], []);
        var other = Input(context: []); other.ThreadId = "other";
        Assert.IsType<RunFinishedEvent>((await Collect(restored, other))[^1]);
        Assert.Single(fake.Sent[4]);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ImportedResultCarriesContextBeforeFollowup(bool partial)
    {
        var fake = new FakeManagedAgentsClient([Idle]) { History = partial ? [Call("c"), Call("other")] : [Call("c")] };
        var input = Input(); input.Messages.Add(new AGUIToolMessage { Id = "r", ToolCallId = "c", Content = "ok" });
        input.Messages.Add(new AGUIUserMessage { Id = "u2", Content = "next" });
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native", LastUserMessageId = "u1" }), input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal("user.custom_tool_result", fake.Sent[0][0].GetProperty("type").GetString());
        AssertContext(fake.Sent[0], Context());
        Assert.Equal(partial ? 1 : 2, fake.Sent.Count);
        if (!partial) Assert.Equal("user.message", Assert.Single(fake.Sent[1]).GetProperty("type").GetString());
    }

    [Fact]
    public async Task FailedSendDoesNotPersistContextAndRetriesIt()
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle]);
        var first = true;
        fake.SendGuard = _ => { if (!first) return null; first = false; return new IOException("offline"); };
        var store = new InMemorySessionStore(); var agent = Agent(fake, store);
        Assert.IsType<RunErrorEvent>((await Collect(agent, Input()))[^1]);
        Assert.Null((await store.GetAsync(Key, default))!.RuntimeContext);
        Assert.IsType<RunFinishedEvent>((await Collect(agent, Input()))[^1]);
        AssertContext(Assert.Single(fake.Sent), Context());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnsupportedContextHasNoNativeSideEffects(bool child)
    {
        var fake = new FakeManagedAgentsClient { History = [Call("c", confirmation: !child)] };
        var input = Input();
        if (child) input.Messages.Add(new AGUIToolMessage { Id = "r", ToolCallId = "c", Content = "ok" });
        else input.Resume = [new AGUIResume { InterruptId = "c", Status = "resolved", Payload = JsonSerializer.SerializeToElement("allow") }];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native", LastUserMessageId = "u1", SessionThreadId = child ? "child" : null }), input);
        Assert.Equal("context_delivery_unsupported", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeImportRestoresLatestSnapshotForClearingOrApproval(bool approval)
    {
        static JsonElement Native(string id, IList<AGUIContext> context) => JsonSerializer.SerializeToElement(new { type = "system.message", id, content = new[] { new { type = "text", text = "AG-UI runtime context snapshot. Replace all earlier AG-UI runtime context snapshots with this complete list; an empty list clears them.\n" + JsonSerializer.Serialize(context) } } });
        var history = new List<JsonElement> { Native("old", [new() { Description = "old", Value = "obsolete" }]), Native("latest", Context()) };
        if (approval) history.Add(Call("c", true));
        var fake = new FakeManagedAgentsClient([Idle]) { History = history };
        var input = approval ? Input() : Input("u2", []);
        if (approval) input.Resume = [new AGUIResume { InterruptId = "c", Status = "resolved", Payload = JsonSerializer.SerializeToElement("allow") }];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native", LastUserMessageId = "u1" }), input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        if (approval) Assert.Equal("user.tool_confirmation", Assert.Single(fake.Sent[0]).GetProperty("type").GetString());
        else AssertContext(fake.Sent[0], []);
    }

    [Theory]
    [InlineData("allow", false, false)]
    [InlineData("allow", true, false)]
    [InlineData("deny", false, false)]
    [InlineData("deny", true, false)]
    [InlineData("allow", false, true)]
    [InlineData("allow", true, true)]
    [InlineData("deny", false, true)]
    [InlineData("deny", true, true)]
    public async Task MixedApprovalAndResultCommitContextAndStateBeforeFollowup(string decision, bool confirmationLastInHistory, bool retry)
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle])
        {
            History = confirmationLastInHistory ? [Call("result"), Call("approval", true)] : [Call("approval", true), Call("result")]
        };
        var failNext = retry;
        fake.SendGuard = batch =>
        {
            // Mirror the native one-final-system-message constraint on every attempt.
            var systems = batch.Select((evt, index) => (evt, index)).Where(item => item.evt.GetProperty("type").GetString() == "system.message").ToList();
            Assert.True(systems.Count <= 1);
            if (systems.Count == 1)
            {
                Assert.Equal(batch.Count - 1, systems[0].index);
                Assert.Contains(batch[^2].GetProperty("type").GetString(), new[] { "user.message", "user.custom_tool_result", "user.tool_result" });
            }
            if (!failNext) return null;
            failNext = false;
            return new IOException("deterministic failed delivery");
        };
        var store = new InMemorySessionStore();
        var agent = Agent(fake, store, new() { SessionId = "native", LastUserMessageId = "u1" });
        var input = Input();
        input.State = JsonSerializer.SerializeToElement(new { board = new { count = 1 } });
        input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement(decision) }];
        input.Messages.Add(new AGUIToolMessage { Id = "tool_result", ToolCallId = "result", Content = "actual tool output" });
        input.Messages.Add(new AGUIUserMessage { Id = "u2", Content = "continue after the result" });
        if (retry)
        {
            var failed = await Collect(agent, input);
            Assert.IsType<RunErrorEvent>(failed[^1]);
            Assert.Empty(fake.Sent);
            Assert.Empty(failed.OfType<StateSnapshotEvent>());
            var unchanged = (await store.GetAsync(Key, default))!;
            Assert.Null(unchanged.RuntimeContext);
            Assert.Null(unchanged.SharedState);
            Assert.Equal(0, unchanged.SharedStateRevision);
            Assert.Contains("approval", unchanged.PendingConfirmationIds);
            Assert.Contains("result", unchanged.PendingClientToolUseIds);
        }
        var events = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(2, fake.Sent.Count);
        var results = fake.Sent[0];
        Assert.Equal(new[] { "user.tool_confirmation", "user.custom_tool_result", "system.message" }, results.Select(evt => evt.GetProperty("type").GetString()));
        Assert.True(JsonElement.DeepEquals(ManagedAgentsSessionEvents.ToolConfirmation("approval", decision), results[0]));
        Assert.Equal("actual tool output", results[1].GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Equal(2, results[^1].GetProperty("content").GetArrayLength());
        AssertContext(results, Context());
        Assert.Equal("user.message", Assert.Single(fake.Sent[1]).GetProperty("type").GetString());
        var committed = (await store.GetAsync(Key, default))!;
        Assert.Equal(JsonSerializer.Serialize(Context()), committed.RuntimeContext);
        Assert.True(JsonElement.DeepEquals(input.State!.Value, committed.SharedState!.Value));
        Assert.Equal(1, committed.SharedStateRevision);
        Assert.Empty(committed.PendingClientToolUseIds);
        Assert.Empty(committed.PendingConfirmationIds);
        Assert.True(JsonElement.DeepEquals(input.State.Value, Assert.Single(events.OfType<StateSnapshotEvent>()).Snapshot));
    }

    [Theory]
    [InlineData("allow")]
    [InlineData("deny")]
    public async Task ApprovalWithFollowupCannotDeliverChangedContextAfterResuming(string decision)
    {
        var fake = new FakeManagedAgentsClient([Idle]) { History = [Call("approval", true)] };
        var store = new InMemorySessionStore();
        var input = Input();
        input.State = JsonSerializer.SerializeToElement(new { changed = true });
        input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement(decision) }];
        input.Messages.Add(new AGUIUserMessage { Id = "u2", Content = "followup is not a result companion" });
        var events = await Collect(Agent(fake, store, new() { SessionId = "native", LastUserMessageId = "u1" }), input);
        Assert.Equal("context_delivery_unsupported", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
        var unchanged = (await store.GetAsync(Key, default))!;
        Assert.Null(unchanged.RuntimeContext);
        Assert.Null(unchanged.SharedState);
        Assert.Contains("approval", unchanged.PendingConfirmationIds);
    }

    private static JsonElement PendingStateCall() => JsonSerializer.SerializeToElement(new
    {
        type = "agent.custom_tool_use", id = "state_call", name = ManagedAgentsState.Name,
        input = new { operation = "replace", expectedRevision = 0, state = new { board = new { count = 2 } } }
    });

    [Theory]
    [InlineData(null, false)]
    [InlineData("allow", false)]
    [InlineData("deny", false)]
    [InlineData(null, true)]
    [InlineData("allow", true)]
    [InlineData("deny", true)]
    public async Task ColdStateResultCarriesChangedContextBeforeAnyResume(string? decision, bool retry)
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle])
        {
            History = decision is null ? [PendingStateCall()] : [PendingStateCall(), Call("approval", true)],
            SessionTools = [ManagedAgentsState.Definition]
        };
        var store = new InMemorySessionStore();
        var input = Input(); input.Messages = [];
        if (decision is not null) input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement(decision) }];
        var failNext = retry;
        fake.SendGuard = batch =>
        {
            if (batch[0].GetProperty("type").GetString() == "user.custom_tool_result")
            {
                Assert.Equal(2, batch.Count);
                Assert.Equal("state_call", batch[0].GetProperty("custom_tool_use_id").GetString());
                Assert.False(batch[0].GetProperty("is_error").GetBoolean());
                AssertContext(batch, Context());
                // Preparing the result/context must not commit either before native success.
                var beforeSend = store.GetAsync(Key, default).AsTask().GetAwaiter().GetResult()!;
                Assert.Null(beforeSend.SharedState);
                Assert.Null(beforeSend.RuntimeContext);
            }
            else
            {
                Assert.Equal("user.tool_confirmation", Assert.Single(batch).GetProperty("type").GetString());
                Assert.Equal(JsonSerializer.Serialize(Context()), store.GetAsync(Key, default).AsTask().GetAwaiter().GetResult()!.RuntimeContext);
            }
            if (!failNext) return null;
            failNext = false;
            return new IOException("deterministic state-result delivery failure");
        };
        var agent = Agent(fake, store, new() { SessionId = "native" });
        if (retry)
        {
            var failed = await Collect(agent, input);
            Assert.Equal("tool_result_delivery_failed", Assert.IsType<RunErrorEvent>(failed[^1]).Code);
            Assert.Empty(fake.Sent);
            Assert.Empty(failed.OfType<StateSnapshotEvent>());
            var retained = (await store.GetAsync(Key, default))!;
            Assert.Null(retained.SharedState);
            Assert.Null(retained.RuntimeContext);
            Assert.Contains("state_call", retained.PendingClientToolUseIds);
        }
        var events = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(decision is null ? 1 : 2, fake.Sent.Count);
        var committed = (await store.GetAsync(Key, default))!;
        Assert.Equal(JsonSerializer.Serialize(Context()), committed.RuntimeContext);
        Assert.Equal(1, committed.SharedStateRevision);
        Assert.Equal(2, committed.SharedState!.Value.GetProperty("board").GetProperty("count").GetInt32());
        Assert.Single(events.OfType<StateSnapshotEvent>());
        Assert.Empty(committed.PendingClientToolUseIds);
        Assert.Empty(committed.PendingConfirmationIds);
    }

    [Fact]
    public async Task ChildPendingStateWithChangedContextFailsBeforeAnyNativeEffects()
    {
        var fake = new FakeManagedAgentsClient([Idle])
        {
            History = [PendingStateCall(), Call("approval", true)], SessionTools = [ManagedAgentsState.Definition]
        };
        var input = Input(); input.Messages = [];
        input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement("allow") }];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native", SessionThreadId = "child" }), input);
        Assert.Equal("context_delivery_unsupported", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
    }

    [Fact]
    public async Task PersistFailureAfterNativeStateResultDoesNotInterruptOrResendIt()
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle])
        { History = [PendingStateCall()], SessionTools = [ManagedAgentsState.Definition] };
        var store = new RecordingSessionStore();
        fake.SendGuard = _ => { store.SetError = new IOException("store unavailable after native delivery"); return null; };
        var input = Input(); input.Messages = [];
        var agent = Agent(fake, store, new() { SessionId = "native" });
        var failed = await Collect(agent, input);
        Assert.Equal("run_failed", Assert.IsType<RunErrorEvent>(failed[^1]).Code);
        Assert.DoesNotContain("user.interrupt", fake.SentTypes);
        AssertContext(Assert.Single(fake.Sent), Context());
        store.SetError = null;
        fake.SendGuard = null;
        var recovered = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(recovered[^1]);
        Assert.Single(fake.Sent);
        var record = (await store.GetAsync(Key, default))!;
        Assert.Equal(JsonSerializer.Serialize(Context()), record.RuntimeContext);
        Assert.Equal(1, record.SharedStateRevision);
        Assert.Equal(2, record.SharedState!.Value.GetProperty("board").GetProperty("count").GetInt32());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InvalidOrDuplicateApprovalPreventsPendingStateAndContextEffects(bool duplicate)
    {
        var fake = new FakeManagedAgentsClient([Idle])
        { History = [PendingStateCall(), Call("approval", true)], SessionTools = [ManagedAgentsState.Definition] };
        var input = Input(); input.Messages = [];
        input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement(duplicate ? "allow" : "invalid") }];
        if (duplicate) input.Resume.Add(new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement("deny") });
        var store = new InMemorySessionStore();
        var events = await Collect(Agent(fake, store, new() { SessionId = "native" }), input);
        Assert.Equal("invalid_resume", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.SendAttempts);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
        var retained = (await store.GetAsync(Key, default))!;
        Assert.Null(retained.SharedState);
        Assert.Null(retained.RuntimeContext);
        Assert.Contains("state_call", retained.PendingClientToolUseIds);
        Assert.Contains("approval", retained.PendingConfirmationIds);
    }

}
