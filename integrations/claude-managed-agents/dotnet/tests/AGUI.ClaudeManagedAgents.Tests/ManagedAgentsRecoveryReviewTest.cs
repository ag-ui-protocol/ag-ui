using System.Text.Json;
using AGUI.Abstractions;
using Xunit;

namespace AGUI.ClaudeManagedAgents.Tests;

public partial class ManagedAgentsRecoveryTest
{
    private const string ReviewKey = "5:agent|0:|3:env|0:|thread";

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task ReconnectCancellationNeverInterruptsNativeSession(bool imported, bool timeout)
    {
        var store = new RecordingSessionStore();
        await store.SetAsync(ReviewKey, new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old", PreserveTools = imported, PendingClientToolUseIds = ["pending"] }, default);
        var fake = new FakeManagedAgentsClient { History = [Call("pending")], HistoryGate = new() };
        var agent = new ManagedAgentsAgent(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = store, TurnTimeout = timeout ? TimeSpan.FromMilliseconds(100) : TimeSpan.FromSeconds(10) });
        using var cancellation = new CancellationTokenSource();
        var run = Collect(agent, Input(), cancellation.Token);
        await fake.HistoryStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        if (!timeout) cancellation.Cancel();
        var events = await run;
        if (timeout)
        {
            var error = Assert.IsType<RunErrorEvent>(events[^1]);
            Assert.Equal("turn_timeout", error.Code); Assert.DoesNotContain("was interrupted", error.Message);
        }
        Assert.Empty(fake.Sent);
        Assert.Equal(new[] { "pending" }, (await store.GetAsync(ReviewKey, default))!.PendingClientToolUseIds);
        fake.HistoryGate = null;
        var resumed = await Collect(Agent(fake, store), Input());
        Assert.Equal("pending", Assert.Single(resumed.OfType<ToolCallStartEvent>()).ToolCallId);
        Assert.IsType<RunFinishedEvent>(resumed[^1]); Assert.Empty(fake.Sent);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BufferedRequiresActionDoesNotReopenAnAlreadySubmittedHistoryAnswer(bool confirmation)
    {
        var fake = new FakeManagedAgentsClient([
            """{"type":"session.status_idle","id":"buffered-idle","stop_reason":{"type":"requires_action","event_ids":["c1"]}}""",
            """{"type":"agent.message","id":"response","content":[{"type":"text","text":"continued"}]}""", Idle])
        { History = [Call("c1", confirmation)] };
        var input = Input();
        if (confirmation) input.Resume = [new AGUIResume { InterruptId = "c1", Payload = JsonSerializer.SerializeToElement("allow") }];
        else input.Messages!.Add(new AGUIToolMessage { Id = "result", ToolCallId = "c1", Content = "answer" });
        var events = await Collect(Agent(fake), input);
        Assert.IsType<RunFinishedEvent>(events[^1]); Assert.Empty(events.OfType<RunErrorEvent>());
        Assert.Equal("continued", Assert.Single(events.OfType<TextMessageContentEvent>()).Delta);
        var answer = Assert.Single(fake.SentEvents);
        Assert.Equal(confirmation ? "user.tool_confirmation" : "user.custom_tool_result", answer.GetProperty("type").GetString());
        Assert.Equal("c1", answer.GetProperty(confirmation ? "tool_use_id" : "custom_tool_use_id").GetString());
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task NativeApprovalParksAtArrivalWithoutGlobalIdleAndSurvivesRestart(bool reconnect, bool mcp)
    {
        var fake = new FakeManagedAgentsClient([
            JsonSerializer.Serialize(new { type = mcp ? "agent.mcp_tool_use" : "agent.tool_use", id = "arrival-approval", name = "bash", input = new { }, evaluated_permission = "ask", session_thread_id = "child", mcp_server_name = "tools" })], [Idle])
        { SessionId = "native" };
        var store = new RecordingSessionStore();
        ManagedAgentsAgent agent;
        if (reconnect)
        {
            fake.History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"running"}""")];
            agent = Agent(fake, store);
        }
        else agent = new(new() { ManagedAgentId = "agent", EnvironmentId = "env", Client = fake, SessionStore = store });
        var first = await Collect(agent, Input());
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(Assert.IsType<RunFinishedEvent>(first[^1]).Outcome);
        Assert.Equal("arrival-approval", Assert.Single(outcome.Interrupts).Id);
        Assert.Equal(new[] { "arrival-approval" }, (await store.GetAsync(ReviewKey, default))!.PendingConfirmationIds);
        Assert.DoesNotContain("user.tool_confirmation", fake.SentTypes); Assert.DoesNotContain("user.interrupt", fake.SentTypes);
        var input = Input(); input.Resume = [new AGUIResume { InterruptId = "arrival-approval", Payload = JsonSerializer.SerializeToElement("allow") }];
        var second = await Collect(Agent(fake, store), input);
        Assert.IsType<RunFinishedEvent>(second[^1]);
        var answer = Assert.Single(fake.SentEvents, evt => evt.GetProperty("type").GetString() == "user.tool_confirmation");
        Assert.Equal("arrival-approval", answer.GetProperty("tool_use_id").GetString());
    }

    [Theory]
    [InlineData(null, "hello world")]
    [InlineData("hello", " world")]
    [InlineData("hello world", "")]
    [InlineData("different", null)]
    public async Task HistoryTextReconcilesFullPartialCompleteAndConflictingContent(string? existing, string? expected)
    {
        var store = new RecordingSessionStore();
        await store.SetAsync(ReviewKey, new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old", LastEventId = "boundary", PreserveTools = true }, default);
        var fake = new FakeManagedAgentsClient { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"boundary"}"""), FakeManagedAgentsClient.Json("""{"type":"agent.message","id":"text","content":[{"type":"text","text":"hello world"}]}"""), FakeManagedAgentsClient.Json(Idle)] };
        var input = Input();
        if (existing is not null) input.Messages!.Add(new AGUIAssistantMessage { Id = "text", Content = existing });
        var events = await Collect(Agent(fake, store), input);
        if (expected is null)
        {
            Assert.Equal("history_content_conflict", Assert.IsType<RunErrorEvent>(events[^1]).Code);
            Assert.Equal("boundary", (await store.GetAsync(ReviewKey, default))!.LastEventId);
        }
        else
        {
            Assert.Equal(expected, string.Concat(events.OfType<TextMessageContentEvent>().Select(evt => evt.Delta)));
            Assert.IsType<RunFinishedEvent>(events[^1]);
            var again = await Collect(Agent(fake, store), input);
            Assert.Empty(again.OfType<TextMessageContentEvent>());
        }
        Assert.Empty(fake.Sent);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BufferedIdleIgnoresAnswersAlreadyPresentInNativeHistory(bool confirmation)
    {
        var answer = JsonSerializer.SerializeToElement(confirmation
            ? new Dictionary<string, object> { ["id"] = "answered", ["type"] = "user.tool_confirmation", ["tool_use_id"] = "c1", ["result"] = "allow" }
            : new Dictionary<string, object> { ["id"] = "answered", ["type"] = "user.custom_tool_result", ["custom_tool_use_id"] = "c1", ["content"] = Array.Empty<object>() });
        var fake = new FakeManagedAgentsClient([
            """{"type":"session.status_idle","id":"late-idle","stop_reason":{"type":"requires_action","event_ids":["c1"]}}""", Idle])
        { History = [Call("c1", confirmation), answer, FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"running"}""")] };
        var events = await Collect(Agent(fake), Input());
        Assert.IsType<RunFinishedEvent>(events[^1]); Assert.Empty(events.OfType<RunErrorEvent>()); Assert.Empty(fake.Sent);
    }

    [Fact]
    public async Task OwnedReconnectDisconnectKeepsLiveCustomToolAnswerable()
    {
        var store = new RecordingSessionStore();
        await store.SetAsync(ReviewKey, new ManagedAgentsSessionRecord { SessionId = "native", LastUserMessageId = "old" }, default);
        var fake = new FakeManagedAgentsClient(["""{"type":"agent.custom_tool_use","id":"live-pending","name":"frontend","input":{}}"""])
        { History = [FakeManagedAgentsClient.Json("""{"type":"session.status_running","id":"running"}""")] };
        using var cancellation = new CancellationTokenSource();
        await foreach (var evt in Agent(fake, store).RunAsync(Input(), cancellation.Token))
            if (evt is ToolCallEndEvent) cancellation.Cancel();
        Assert.Empty(fake.Sent);
        Assert.Equal(new[] { "live-pending" }, (await store.GetAsync(ReviewKey, default))!.PendingClientToolUseIds);
        var restarted = await Collect(Agent(fake, store), Input());
        Assert.Equal("live-pending", Assert.Single(restarted.OfType<ToolCallStartEvent>()).ToolCallId);
        Assert.IsType<RunFinishedEvent>(restarted[^1]); Assert.Empty(fake.Sent);
    }
}
