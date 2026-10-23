using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public class ManagedAgentsStateTest
{
    private const string Key = "1:a|0:|1:e|0:|t";
    private const string Idle = """{"type":"session.status_idle","id":"idle","stop_reason":{"type":"end_turn"}}""";
    private const string PatchCall = """{"type":"agent.custom_tool_use","id":"write","name":"ag_ui_update_state","input":{"operation":"merge_patch","expectedRevision":1,"patch":{"board":{"count":2,"obsolete":null},"items":[2]}}}""";
    private static JsonElement Json(string text) => JsonSerializer.Deserialize<JsonElement>(text);
    private static RunAgentInput Input(string? state = null, string id = "u1") => new() { ThreadId = "t", RunId = "r", Tools = [], Context = [], State = state is null ? null : Json(state), Messages = [new AGUIUserMessage { Id = id, Content = "Update the shared board" }] };
    private static ManagedAgentsAgent Agent(FakeManagedAgentsClient fake, ISessionStore? store = null, ManagedAgentsSessionBinding? binding = null) => new(new() { ManagedAgentId = "a", EnvironmentId = "e", Client = fake, SessionStore = store, ResolveSession = binding is null ? null : (_, _) => Task.FromResult<ManagedAgentsSessionBinding?>(binding) });
    private static async Task<List<BaseEvent>> Collect(ManagedAgentsAgent agent, RunAgentInput input)
    { List<BaseEvent> events = []; await foreach (var evt in agent.RunAsync(input)) events.Add(evt); return events; }

    [Fact]
    public async Task ModelReadsInitialStateWritesPatchAndColdImportRetainsThenClears()
    {
        var fake = new FakeManagedAgentsClient([PatchCall, Idle], [Idle.Replace("\"id\":\"idle\"", "\"id\":\"idle2\"", StringComparison.Ordinal)], [Idle.Replace("\"id\":\"idle\"", "\"id\":\"idle3\"", StringComparison.Ordinal)]);
        var store = new InMemorySessionStore();
        var events = await Collect(Agent(fake, store), Input("""{"board":{"count":1,"obsolete":true},"items":[1]}"""));
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(2, events.OfType<StateSnapshotEvent>().Count());
        var initial = fake.Sent[0].Single(evt => evt.GetProperty("type").GetString() == "system.message");
        Assert.Contains("AG-UI shared state v1\n", initial.GetProperty("content")[0].GetProperty("text").GetString());
        var committed = (await store.GetAsync(Key, default))!;
        Assert.Equal(2, committed.SharedStateRevision);
        Assert.True(JsonElement.DeepEquals(Json("""{"board":{"count":2},"items":[2]}"""), committed.SharedState!.Value));
        var imported = Agent(fake, binding: new() { SessionId = fake.SessionId, LastUserMessageId = "u1" });
        var restored = await Collect(imported, Input(id: "u2"));
        Assert.IsType<RunFinishedEvent>(restored[^1]);
        Assert.True(JsonElement.DeepEquals(committed.SharedState.Value, Assert.Single(restored.OfType<StateSnapshotEvent>()).Snapshot));
        Assert.Single(fake.Sent[^1]);
        var cleared = await Collect(imported, Input("{}", "u3"));
        Assert.IsType<RunFinishedEvent>(cleared[^1]);
        Assert.Equal("{}", cleared.OfType<StateSnapshotEvent>().Last().Snapshot.GetRawText());
    }

    [Fact]
    public async Task FailedNativeWriteNeverCommitsModelPatch()
    {
        var fake = new FakeManagedAgentsClient([PatchCall, Idle]) { SendGuard = events => events.Any(evt => evt.GetProperty("type").GetString() == "user.custom_tool_result") ? new IOException("offline") : null };
        var store = new InMemorySessionStore();
        var events = await Collect(Agent(fake, store), Input("{\"board\":{\"count\":1}}"));
        Assert.Equal("tool_result_delivery_failed", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Single(events.OfType<StateSnapshotEvent>());
        Assert.Equal(1, (await store.GetAsync(Key, default))!.SharedStateRevision);
    }

    [Fact]
    public async Task ImportedCatalogPreservedWhenAddingReservedTool()
    {
        var tool = Json("""{"type":"custom","name":"imported_tool","description":"keep me","input_schema":{"type":"object"}}""");
        var fake = new FakeManagedAgentsClient([Idle]) { SessionTools = [tool] };
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native", LastUserMessageId = "previous" }), Input("{}"));
        Assert.IsType<RunFinishedEvent>(events[^1]);
        var updated = Assert.Single(fake.Updates);
        Assert.True(JsonElement.DeepEquals(tool, updated[0]));
        Assert.Equal(ManagedAgentsState.Name, updated[1].GetProperty("name").GetString());
    }

    [Fact]
    public void ReplayRejectsFailedForeignChildAndConflictingCommits()
    {
        var record = new ManagedAgentsSessionRecord { SessionId = "native", PrimaryThreadId = "primary" };
        var calls = new Dictionary<string, JsonElement> { ["write"] = Json(PatchCall) };
        JsonElement Result(string owner, long revision, bool failed = false, string thread = "primary") => JsonSerializer.SerializeToElement(new { type = "user.custom_tool_result", custom_tool_use_id = "write", session_thread_id = thread, is_error = failed, content = new[] { new { type = "text", text = ManagedAgentsState.Snapshot(new() { SessionId = owner }, Json("{}"), revision) } } });
        Assert.False(ManagedAgentsState.Restore(Result("native", 1, true), record, calls));
        Assert.False(ManagedAgentsState.Restore(Result("foreign", 1), record, calls));
        Assert.False(ManagedAgentsState.Restore(Result("native", 1, thread: "child"), record, calls));
        Assert.True(ManagedAgentsState.Restore(Result("native", 3), record, calls));
        Assert.False(ManagedAgentsState.Restore(Result("native", 2), record, calls));
        Assert.False(ManagedAgentsState.Restore(Result("native", 3), record, calls));
        var foreignCall = System.Text.Json.Nodes.JsonNode.Parse(PatchCall)!.AsObject(); foreignCall["session_id"] = "foreign";
        calls["write"] = JsonSerializer.SerializeToElement(foreignCall);
        Assert.False(ManagedAgentsState.Restore(Result("native", 4), record, calls));
        Assert.Equal(3, record.SharedStateRevision);
    }

    [Fact]
    public async Task NativeReplayOverridesPoisonedCacheAndAbsenceStaysAbsent()
    {
        var store = new InMemorySessionStore();
        await store.SetAsync(Key, new() { SessionId = "native", SharedState = Json("{\"poison\":true}"), SharedStateRevision = 100 }, default);
        var input = Input(); input.Messages = [];
        var fake = new FakeManagedAgentsClient();
        var events = await Collect(Agent(fake, store), input);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
        Assert.Null((await store.GetAsync(Key, default))!.SharedState);
        Assert.Equal(0, (await store.GetAsync(Key, default))!.SharedStateRevision);
    }

    [Fact]
    public async Task ReservedFrontendNameRejectedEvenDuringImport()
    {
        var fake = new FakeManagedAgentsClient(); var input = Input();
        input.Tools = [new AGUITool { Name = ManagedAgentsState.Name }];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native" }), input);
        Assert.Equal("reserved_state_tool_conflict", Assert.IsType<RunErrorEvent>(events[^1]).Code);
        Assert.Empty(fake.Sent);
    }

    [Fact]
    public void ChildDefaultStateIsIgnoredAndOverflowCannotBeSent()
    {
        var events = new List<JsonElement> { ManagedAgentsSessionEvents.UserMessage("next") };
        Assert.Null(ManagedAgentsState.Attach(events, Json("{}"), new() { SessionThreadId = "child" }));
        Assert.Throws<ArgumentException>(() => ManagedAgentsState.Attach(events, Json("{}"), new() { SharedStateRevision = 9007199254740991 }));
        Assert.Single(events);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ColdPendingStateCallResumesUnderOriginalId(bool knownCall)
    {
        var initial = JsonSerializer.SerializeToElement(new { type = "system.message", id = "initial", content = new[] { new { type = "text", text = ManagedAgentsState.Snapshot(new() { SessionId = "native" }, Json("{\"board\":{\"count\":1,\"obsolete\":true}}"), 1) } } });
        var fake = new FakeManagedAgentsClient([Idle])
        {
            History = [initial, Json(PatchCall), Json("""{"type":"session.status_idle","id":"parked","stop_reason":{"type":"requires_action","event_ids":["write"]}}""")],
            SessionTools = [ManagedAgentsState.Definition]
        };
        var input = Input(); input.Messages = [];
        if (knownCall) input.Messages.Add(new AGUIAssistantMessage { Id = "assistant", ToolCalls = [new AGUIToolCall { Id = "write", Function = new() { Name = ManagedAgentsState.Name, Arguments = "{}" } }] });
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native" }), input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(2, events.OfType<StateSnapshotEvent>().Last().Snapshot.GetProperty("board").GetProperty("count").GetInt32());
        if (knownCall) Assert.Empty(events.OfType<ToolCallStartEvent>());
        else
        {
            Assert.Equal("write", Assert.Single(events.OfType<ToolCallStartEvent>()).ToolCallId);
            Assert.True(events.FindIndex(evt => evt is ToolCallEndEvent) < events.FindIndex(evt => evt is ToolCallResultEvent));
        }
        Assert.Equal("write", Assert.Single(fake.SentEvents).GetProperty("custom_tool_use_id").GetString());
        Assert.False(Assert.Single(fake.SentEvents).GetProperty("is_error").GetBoolean());
    }

    [Fact]
    public async Task CrossPostedChildModelWriteIsIgnoredAndDoesNotOverwritePrimaryState()
    {
        var call = System.Text.Json.Nodes.JsonNode.Parse(PatchCall)!.AsObject(); call["session_thread_id"] = "child";
        var fake = new FakeManagedAgentsClient([call.ToJsonString(), Idle]) { PrimaryThreadId = "primary" };
        var store = new InMemorySessionStore();
        var events = await Collect(Agent(fake, store), Input("{\"board\":{\"count\":1}}"));
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(1, (await store.GetAsync(Key, default))!.SharedStateRevision);
        Assert.DoesNotContain(fake.SentEvents, evt => evt.GetProperty("type").GetString() == "user.custom_tool_result");
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ChildReservedCallRemainsPendingUntilOriginalClientResult(bool live, bool childBinding)
    {
        var call = System.Text.Json.Nodes.JsonNode.Parse(PatchCall)!.AsObject(); call["session_thread_id"] = "child";
        const string parked = """{"type":"session.status_idle","id":"parked","stop_reason":{"type":"requires_action","event_ids":["write"]}}""";
        var fake = new FakeManagedAgentsClient(live ? [call.ToJsonString(), parked] : [], [], [], [Idle], [])
        {
            PrimaryThreadId = "primary",
            History = live ? [Json("""{"type":"session.status_running","id":"running"}""")] : [Json(call.ToJsonString()), Json(parked)]
        };
        var initial = JsonSerializer.SerializeToElement(new { type = "system.message", id = "initial", session_thread_id = "primary", content = new[] { new { type = "text", text = ManagedAgentsState.Snapshot(new() { SessionId = "native" }, Json("{\"parent\":true}"), 1) } } });
        fake.History = new[] { initial }.Concat(fake.History).ToList();
        var store = new InMemorySessionStore();
        var agent = Agent(fake, store, new() { SessionId = "native", SessionThreadId = childBinding ? "child" : null });
        var input = Input(); input.Messages = [];
        var first = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(first[^1]);
        Assert.Equal("write", Assert.Single(first.OfType<ToolCallStartEvent>()).ToolCallId);
        Assert.Equal(ManagedAgentsState.Name, Assert.Single(first.OfType<ToolCallStartEvent>()).ToolCallName);
        Assert.Empty(first.OfType<ToolCallResultEvent>());
        Assert.Empty(fake.Sent);
        Assert.Equal(["write"], (await store.GetAsync(Key, default))!.PendingClientToolUseIds);
        var snapshot = (await store.GetAsync(Key, default))!.SharedState;
        if (childBinding) Assert.Null(snapshot);
        else Assert.True(snapshot!.Value.GetProperty("parent").GetBoolean());
        input.Messages.Add(new AGUIAssistantMessage { Id = "assistant", ToolCalls = [new AGUIToolCall { Id = "write", Function = new() { Name = ManagedAgentsState.Name, Arguments = call["input"]!.ToJsonString() } }] });
        store = new InMemorySessionStore();
        agent = Agent(fake, store, new() { SessionId = "native", SessionThreadId = childBinding ? "child" : null });
        var repeated = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(repeated[^1]);
        Assert.Empty(repeated.OfType<ToolCallStartEvent>());
        Assert.Empty(fake.Sent);
        Assert.Equal(["write"], (await store.GetAsync(Key, default))!.PendingClientToolUseIds);
        input.Messages.Add(new AGUIToolMessage { Id = "result", ToolCallId = "write", Content = "Child state writes are unsupported" });
        fake.SendGuard = _ => new IOException("offline");
        Assert.IsType<RunErrorEvent>((await Collect(agent, input))[^1]);
        Assert.Equal(["write"], (await store.GetAsync(Key, default))!.PendingClientToolUseIds);
        Assert.Empty(fake.Sent);
        fake.SendGuard = null;
        var completed = await Collect(agent, input);
        Assert.IsType<RunFinishedEvent>(completed[^1]);
        var sent = Assert.Single(fake.SentEvents);
        Assert.Equal("write", sent.GetProperty("custom_tool_use_id").GetString());
        Assert.Equal("native", Assert.Single(fake.SentSessionIds));
        Assert.Equal("Child state writes are unsupported", sent.GetProperty("content")[0].GetProperty("text").GetString());
        Assert.Empty((await store.GetAsync(Key, default))!.PendingClientToolUseIds);
        snapshot = (await store.GetAsync(Key, default))!.SharedState;
        if (childBinding) Assert.Null(snapshot);
        else Assert.True(snapshot!.Value.GetProperty("parent").GetBoolean());
        agent = Agent(fake, new InMemorySessionStore(), new() { SessionId = "native", SessionThreadId = childBinding ? "child" : null });
        Assert.IsType<RunFinishedEvent>((await Collect(agent, input))[^1]);
        Assert.Single(fake.SentEvents);
        Assert.Empty((await store.GetAsync(Key, default))!.PendingClientToolUseIds);
    }

    [Fact]
    public async Task ApprovalOnlyDefersChangedStateWithoutDroppingApproval()
    {
        var fake = new FakeManagedAgentsClient([Idle]) { History = [Json("""{"type":"agent.tool_use","id":"approval","name":"bash","input":{},"evaluated_permission":"ask"}""")] };
        var input = Input("{\"changed\":true}"); input.Messages = [];
        input.Resume = [new AGUIResume { InterruptId = "approval", Status = "resolved", Payload = JsonSerializer.SerializeToElement("allow") }];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native" }), input);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
        Assert.Equal("user.tool_confirmation", Assert.Single(fake.SentEvents).GetProperty("type").GetString());
    }

    [Fact]
    public async Task ImportedConflictingReservedToolCannotMutateState()
    {
        var fake = new FakeManagedAgentsClient([PatchCall, Idle])
        {
            History = [Json("""{"type":"session.status_running","id":"running"}""")],
            SessionTools = [Json("""{"type":"custom","name":"ag_ui_update_state","description":"unrelated","input_schema":{"type":"object"}}""")]
        };
        var input = Input(); input.Messages = [];
        var events = await Collect(Agent(fake, binding: new() { SessionId = "native" }), input);
        Assert.IsType<RunErrorEvent>(events[^1]);
        Assert.Empty(events.OfType<StateSnapshotEvent>());
        Assert.Empty(fake.SentEvents);
        Assert.Empty(fake.Updates);
    }

    [Fact]
    public void EmptyPatchRetainsAbsenceAndReplacementStoresNullMembers()
    {
        var record = new ManagedAgentsSessionRecord();
        Assert.Equal(0, ManagedAgentsState.Apply(record, Json("""{"operation":"merge_patch","expectedRevision":0,"patch":{}}""")).Revision);
        var replaced = ManagedAgentsState.Apply(record, Json("""{"operation":"replace","expectedRevision":0,"state":{"nullable":null}}"""));
        Assert.Equal(1, replaced.Revision);
        Assert.Equal(JsonValueKind.Null, replaced.State.GetProperty("nullable").ValueKind);
    }

    [Theory]
    [InlineData("{\"operation\":\"replace\",\"expectedRevision\":2,\"state\":{}}")]
    [InlineData("{\"operation\":\"merge_patch\",\"expectedRevision\":1,\"patch\":{\"__proto__\":{}}}")]
    public void InvalidWritesLeaveStateUntouched(string input)
    {
        var record = new ManagedAgentsSessionRecord { SharedState = Json("{\"x\":1}"), SharedStateRevision = 1 };
        Assert.Throws<ArgumentException>(() => ManagedAgentsState.Apply(record, Json(input)));
        Assert.Equal("{\"x\":1}", record.SharedState!.Value.GetRawText());
    }
}
