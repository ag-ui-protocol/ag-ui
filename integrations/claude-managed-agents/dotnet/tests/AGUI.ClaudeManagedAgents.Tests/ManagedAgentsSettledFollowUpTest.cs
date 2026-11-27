using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public partial class ManagedAgentsRecoveryTest
{
    private static RunAgentInput FollowUp(string id)
    {
        var input = Input();
        input.Messages = [new AGUIUserMessage { Id = id, Content = "continue" }];
        return input;
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    public async Task SettledFollowUpReadsOnlyTheLatestEvent(int historySize)
    {
        var fake = new FakeManagedAgentsClient([Idle], [Idle.Replace("done", "second-end")], [Idle.Replace("done", "third-end")]);
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake });
        await Collect(agent, Input());
        var end = fake.History[^1];
        fake.History = [.. Enumerable.Range(0, historySize - 1).Select(i => Call($"old-{i}")), end];
        foreach (var id in new[] { "second", "third" })
            Assert.IsType<RunFinishedEvent>((await Collect(agent, FollowUp(id)))[^1]);
        Assert.Equal(new[] { "stream", "latest", "stream", "latest" }, fake.RecoveryOrder);
        Assert.Equal(3, fake.SentTypes.Count(type => type == "user.message"));
    }

    [Fact]
    public async Task ExternalPermissionAfterCleanEndStillParksTheFollowUp()
    {
        var fake = new FakeManagedAgentsClient([Idle], []);
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake });
        await Collect(agent, Input());
        fake.History = [.. fake.History, Call("external", true)];
        var events = await Collect(agent, FollowUp("second"));
        var approval = Assert.IsType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(events[^1]).Outcome);
        Assert.Equal("external", Assert.Single(approval.Interrupts).Id);
        Assert.Equal(new[] { "stream", "latest", "history" }, fake.RecoveryOrder);
        Assert.Single(fake.SentTypes, type => type == "user.message");
    }

    [Fact]
    public async Task FailedSendConsumesCleanEndBeforeRetry()
    {
        var fake = new FakeManagedAgentsClient([Idle], [], [Idle.Replace("done", "second-end")]);
        var store = new RecordingSessionStore();
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = store });
        await Collect(agent, Input());
        fake.SendGuard = _ => new HttpRequestException("send failed");
        Assert.IsType<RunErrorEvent>((await Collect(agent, FollowUp("second")))[^1]);
        Assert.Null(store.Writes[^1].Record.CleanEndEventId);
        fake.SendGuard = null;
        Assert.IsType<RunFinishedEvent>((await Collect(agent, FollowUp("second")))[^1]);
        Assert.Equal(new[] { "stream", "latest", "stream", "history" }, fake.RecoveryOrder);
    }

    [Fact]
    public async Task LateRequiresActionChecksEarlierAnswersAfterSend()
    {
        const string delayed = """{"id":"repeat","type":"session.status_idle","stop_reason":{"type":"requires_action","event_ids":["old-call"]}}""";
        var fake = new FakeManagedAgentsClient([Idle], [delayed, Idle.Replace("done", "second-end")]) { History = [Call("old-call")] };
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake });
        await Collect(agent, Input());
        fake.SendGuard = _ =>
        {
            Assert.Equal(new[] { "stream", "latest" }, fake.RecoveryOrder);
            return null;
        };
        var events = await Collect(agent, FollowUp("second"));
        Assert.Null(Assert.IsType<RunFinishedEvent>(events[^1]).Outcome);
        Assert.Equal(new[] { "stream", "latest", "history" }, fake.RecoveryOrder);
        Assert.Equal(2, fake.Sent.Count);
    }

    [Theory]
    [InlineData("old-record")]
    [InlineData("empty-reconnect")]
    [InlineData("external-system")]
    [InlineData("external-result")]
    public async Task UnverifiedFollowUpUsesFullHistory(string reason)
    {
        var initial = new List<string>();
        if (reason == "external-system")
            initial.Add("""{"id":"system","type":"system.message","content":[{"type":"text","text":"external"}]}""");
        if (reason == "external-result")
            initial.Add("""{"id":"result","type":"user.custom_tool_result","custom_tool_use_id":"old","content":[]}""");
        initial.Add(Idle);
        var fake = new FakeManagedAgentsClient(initial, [Idle.Replace("done", "second-end")]);
        var store = new RecordingSessionStore();
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = store });
        await Collect(agent, Input());
        if (reason == "old-record")
        {
            var (key, record) = store.Writes[^1];
            record.CleanEndEventId = null;
            await store.SetAsync(key, record, CancellationToken.None);
        }
        var input = FollowUp("second");
        if (reason == "empty-reconnect") input.Messages = [];
        Assert.IsType<RunFinishedEvent>((await Collect(agent, input))[^1]);
        Assert.Equal(new[] { "stream", "history" }, fake.RecoveryOrder);
    }

    [Fact]
    public async Task RestartKeepsSharedStateWithoutResendingContext()
    {
        var store = new RecordingSessionStore();
        var fake = new FakeManagedAgentsClient([Idle], [Idle.Replace("done", "second-end")]);
        var options = new ManagedAgentsAgentOptions { ManagedAgentId = "agent", EnvironmentId = "env", SessionStore = store, Client = fake };
        var input = Input();
        input.State = JsonSerializer.SerializeToElement(new { count = 1 });
        input.Context = [new() { Description = "catalog", Value = "one" }];
        await Collect(new ManagedAgentsAgent(options), input);
        var next = FollowUp("second");
        next.State = input.State;
        next.Context = input.Context;
        var events = await Collect(new ManagedAgentsAgent(options), next);
        Assert.IsType<RunFinishedEvent>(events[^1]);
        Assert.Equal(1, Assert.Single(events.OfType<StateSnapshotEvent>()).Snapshot.GetProperty("count").GetInt32());
        Assert.Equal("user.message", Assert.Single(fake.Sent[^1]).GetProperty("type").GetString());
        Assert.Equal(new[] { "stream", "latest" }, fake.RecoveryOrder);
    }
}
