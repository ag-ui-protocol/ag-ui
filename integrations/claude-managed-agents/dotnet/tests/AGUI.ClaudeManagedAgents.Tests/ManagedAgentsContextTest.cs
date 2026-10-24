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

}
