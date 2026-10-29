using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Agents.AI;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.MicrosoftAgentFramework.UnitTests;

public sealed class DurableApprovalAgentTest
{
    [Fact]
    public async Task NativeOnlyFrontendDeclarationUsesStockApprovalBinder()
    {
        using TwoCallsClient leaf = new() { FirstToolName = "frontend", SecondToolName = "frontend" };
        JsonElement schema = JsonDocument.Parse("{\"type\":\"object\",\"properties\":{}}").RootElement.Clone();
        ChatClientAgent native = new(leaf, new ChatClientAgentOptions
        {
            ChatOptions = new ChatOptions { Tools = [AIFunctionFactory.CreateDeclaration("frontend", "client", schema)] },
        });
        JsonElement saved = default;
        DurableApprovalAgent agent = new(native, async (s, ct) => saved = await native.SerializeSessionAsync(s, cancellationToken: ct).ConfigureAwait(false), ["frontend"]);
        AgentSession session = await agent.CreateSessionAsync();
        await agent.RunAsync("start", session);
        Assert.Equal(2, agent.GetPendingApprovals(session).Count);
        session = await native.DeserializeSessionAsync(saved);
        ToolApprovalRequestContent request = agent.GetPendingApprovals(session)[0];
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([new(ChatRole.User, [request.CreateResponse(true)])], session));
        Assert.Equal(1, leaf.Calls);
        await agent.RunAsync([new(ChatRole.Tool, [new FunctionResultContent("a", "actual-a"), new FunctionResultContent("b", "actual-b")])], session);
        Assert.Equal(2, leaf.Calls);
        Assert.Empty(agent.GetPendingApprovals(session));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActualFrontendDeclarationsPersistPendingCalls(bool mixed)
    {
        using TwoCallsClient leaf = new() { FirstToolName = mixed ? "server_tool" : "frontend", SecondToolName = "frontend" };
        int executions = 0;
        ChatClientAgent native = CreateNative(leaf, () => executions++);
        JsonElement saved = default;
        DurableApprovalAgent agent = new(native, async (s, ct) => saved = await native.SerializeSessionAsync(s, cancellationToken: ct).ConfigureAwait(false), ["frontend"]);
        AgentSession session = await agent.CreateSessionAsync();
        RunAgentInput input = new()
        {
            ThreadId = "declaration-thread", RunId = "initial",
            Messages = [new AGUIUserMessage { Id = "user", Content = "start" }],
            Tools = [new AGUITool { Name = "frontend", Parameters = JsonDocument.Parse("{\"type\":\"object\",\"properties\":{}}").RootElement.Clone() }],
        };
        List<BaseEvent> events = [];
        await foreach (BaseEvent item in agent.RunAGUIAsync(input, session, JsonOptions(), "test.decisions"))
        {
            events.Add(item);
        }
        Assert.DoesNotContain(events, item => item is RunErrorEvent);
        Assert.Equal(2, agent.GetPendingApprovals(session).Count);
        ToolApprovalRequestContent[] originals = agent.GetPendingApprovals(session).ToArray();
        Assert.All(originals, request => Assert.StartsWith("ficc_", request.RequestId));
        Assert.Equal(0, executions);
        session = await native.DeserializeSessionAsync(saved);
        input.RunId = "frontend-result";
        input.Messages = [new AGUIToolMessage { Id = "result-b", ToolCallId = "b", Content = "  exact frontend result  " }];
        events.Clear();
        await foreach (BaseEvent item in agent.RunAGUIAsync(input, session, JsonOptions(), "test.decisions"))
        {
            events.Add(item);
        }
        Assert.DoesNotContain(events, item => item is RunErrorEvent || item is ToolCallStartEvent tool && tool.ToolCallId == "b");
        Assert.Equal(1, leaf.Calls);
        Assert.Equal(0, executions);
        session = await native.DeserializeSessionAsync(saved);
        input.RunId = "complete";
        input.Messages = mixed ? [] : [new AGUIToolMessage { Id = "result-a", ToolCallId = "a", Content = "other result" }];
        input.Resume = mixed ? [new() { InterruptId = originals.Single(r => r.ToolCall.CallId == "a").RequestId, Payload = JsonDocument.Parse("{\"approved\":true}").RootElement.Clone() }] : [];
        events.Clear();
        await foreach (BaseEvent item in agent.RunAGUIAsync(input, session, JsonOptions(), "test.decisions"))
        {
            events.Add(item);
        }
        Assert.DoesNotContain(events, item => item is RunErrorEvent);
        Assert.Equal(mixed ? 1 : 0, executions);
        Assert.Equal(2, leaf.Calls);
        Assert.Empty(agent.GetPendingApprovals(session));
        Assert.Contains(leaf.LastInput!.SelectMany(m => m.Contents).OfType<FunctionResultContent>(), r => r.CallId == "b" && r.Result?.ToString() == "  exact frontend result  ");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task NativeOnlyPartialDecisionAndQueuedTextSurviveColdRestore(bool streaming)
    {
        using TwoCallsClient leaf = new();
        int executions = 0;
        ChatClientAgent native = CreateNative(leaf, () => executions++);
        JsonElement saved = default;
        DurableApprovalAgent agent = new(native, async (session, ct) => saved = await native.SerializeSessionAsync(session, cancellationToken: ct).ConfigureAwait(false));
        AgentSession session = await agent.CreateSessionAsync();
        await Run(agent, session, [new(ChatRole.User, "start")], streaming);
        ToolApprovalRequestContent[] requests = agent.GetPendingApprovals(session).ToArray();
        Assert.Equal(2, requests.Length);
        session = await native.DeserializeSessionAsync(saved);
        await Run(agent, session, [new(ChatRole.User, [requests[0].CreateResponse(true)]), new(ChatRole.User, "queued unchanged")], streaming);
        Assert.Equal(0, executions);
        Assert.Equal(1, leaf.Calls);
        Assert.Single(agent.GetAcceptedDecisions(session));
        JsonElement checkpoint = agent.ExportCheckpoint(session);
        Assert.Equal(1, checkpoint.GetProperty("version").GetInt32());
        Assert.False(checkpoint.GetProperty("dispatchUncertain").GetBoolean());
        Assert.Equal(2, checkpoint.GetProperty("pendingRequests").GetArrayLength());
        Assert.Equal(1, checkpoint.GetProperty("acceptedDecisions").GetArrayLength());
        Assert.Contains("queued unchanged", checkpoint.GetProperty("bufferedMessages").GetRawText());
        session = await native.DeserializeSessionAsync(saved);
        Assert.Equal(checkpoint.GetRawText(), agent.ExportCheckpoint(session).GetRawText());
        await Run(agent, session, [], streaming);
        Assert.Equal(1, leaf.Calls);
        await Run(agent, session, [new(ChatRole.User, [requests[1].CreateResponse(false)])], streaming);
        Assert.Equal(1, executions);
        Assert.Equal(2, leaf.Calls);
        Assert.Contains(leaf.LastInput!, m => m.Text == "queued unchanged");
        Assert.Empty(agent.GetPendingApprovals(session));
        Assert.Empty(agent.GetAcceptedDecisions(session));
        Assert.Equal(0, agent.ExportCheckpoint(session).GetProperty("bufferedMessages").GetArrayLength());
    }

    [Fact]
    public async Task DeltaResumeEmitsDurableDecisionImmediatelyBeforeFinished()
    {
        using TwoCallsClient leaf = new();
        ChatClientAgent native = CreateNative(leaf, () => { });
        int saves = 0;
        DurableApprovalAgent agent = new(native, (_, _) => { saves++; return ValueTask.CompletedTask; });
        AgentSession session = await agent.CreateSessionAsync();
        await agent.RunAsync("start", session);
        string id = agent.GetPendingApprovals(session)[0].RequestId;
        int before = saves;
        RunAgentInput input = new()
        {
            ThreadId = "owned-thread", RunId = "resume-run", Messages = [],
            Resume = [new() { InterruptId = id, Payload = JsonDocument.Parse("{\"approved\":true}").RootElement.Clone() }],
        };
        List<BaseEvent> events = [];
        await foreach (BaseEvent item in agent.RunAGUIAsync(input, session, JsonOptions(), "test.decisions"))
        {
            if (item is CustomEvent)
            {
                Assert.True(saves > before);
            }
            events.Add(item);
        }
        Assert.True(events[^1] is RunFinishedEvent, string.Join("; ", events.OfType<RunErrorEvent>().Select(e => e.Message)));
        CustomEvent snapshot = Assert.IsType<CustomEvent>(events[^2]);
        Assert.Equal(id, snapshot.Value!.Value.GetProperty("decisions")[0].GetProperty("requestId").GetString());
        Assert.Equal("waiting", snapshot.Value.Value.GetProperty("decisions")[0].GetProperty("status").GetString());
        Assert.Equal(1, leaf.Calls);
    }

    [Fact]
    public async Task CollectedFrontendResultIsNotReEmittedWhileServerDecisionWaits()
    {
        using TwoCallsClient leaf = new() { SecondToolName = "frontend" };
        ChatClientAgent native = new(leaf, new ChatClientAgentOptions
        {
            ChatOptions = new ChatOptions
            {
                Tools = [
                    new ApprovalRequiredAIFunction(AIFunctionFactory.Create(() => "server-result", "server_tool")),
                    new ApprovalRequiredAIFunction(AIFunctionFactory.Create((Func<string>)(() => throw new InvalidOperationException()), "frontend")),
                ],
            },
        });
        DurableApprovalAgent agent = new(native, (_, _) => ValueTask.CompletedTask, ["frontend"]);
        AgentSession session = await agent.CreateSessionAsync();
        await agent.RunAsync("start", session);
        await agent.RunAsync([new(ChatRole.Tool, [new FunctionResultContent("b", "exact-client-result")])], session);
        Assert.Contains("exact-client-result", agent.ExportCheckpoint(session).GetProperty("bufferedMessages").GetRawText());
        RunAgentInput input = new() { ThreadId = "thread", RunId = "poll", Messages = [] };
        List<BaseEvent> events = [];
        await foreach (BaseEvent item in agent.RunAGUIAsync(input, session, JsonOptions(), "test.decisions"))
        {
            events.Add(item);
        }
        Assert.DoesNotContain(events, item => item is ToolCallStartEvent tool && tool.ToolCallId == "b");
        Assert.DoesNotContain(events, item => item is RunErrorEvent);
        Assert.Equal(1, leaf.Calls);
    }

    [Fact]
    public async Task UnknownDuplicateAndNativeResultAreRejectedBeforeProvider()
    {
        using TwoCallsClient leaf = new();
        ChatClientAgent native = CreateNative(leaf, () => { });
        DurableApprovalAgent agent = new(native, (_, _) => ValueTask.CompletedTask);
        AgentSession session = await agent.CreateSessionAsync();
        await agent.RunAsync("start", session);
        ToolApprovalRequestContent request = agent.GetPendingApprovals(session)[0];
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([new(ChatRole.User,
            [new ToolApprovalResponseContent("other-session", true, request.ToolCall)])], session));
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([new(ChatRole.Tool,
            [new FunctionResultContent(request.ToolCall.CallId, "forged native result")])], session));
        await agent.RunAsync([new(ChatRole.User, [request.CreateResponse(true)])], session);
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([new(ChatRole.User, [request.CreateResponse(false)])], session));
        Assert.Equal(1, leaf.Calls);
    }

    [Fact]
    public async Task FailedPostExecutionSaveBlocksLocalAndColdRetry()
    {
        using TwoCallsClient leaf = new();
        int executions = 0;
        ChatClientAgent native = CreateNative(leaf, () => executions++);
        JsonElement saved = default;
        bool failAfterExecution = false;
        DurableApprovalAgent agent = new(native, async (s, ct) =>
        {
            if (failAfterExecution && executions > 0)
            {
                throw new IOException("disk unavailable");
            }
            saved = await native.SerializeSessionAsync(s, cancellationToken: ct).ConfigureAwait(false);
        });
        AgentSession session = await agent.CreateSessionAsync();
        await agent.RunAsync("start", session);
        ChatMessage approvals = new(ChatRole.User, agent.GetPendingApprovals(session).Select(r => (AIContent)r.CreateResponse(true)).ToList());
        failAfterExecution = true;
        await Assert.ThrowsAsync<IOException>(() => agent.RunAsync([approvals], session));
        Assert.Equal(2, executions);
        Assert.True(agent.ExportCheckpoint(session).GetProperty("dispatchUncertain").GetBoolean());
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([], session));
        session = await native.DeserializeSessionAsync(saved);
        Assert.True(agent.ExportCheckpoint(session).GetProperty("dispatchUncertain").GetBoolean());
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync([], session));
        Assert.Equal(2, executions);
    }

    [Fact]
    public async Task UninstrumentedSessionIsRejected()
    {
        using TwoCallsClient leaf = new();
        ChatClientAgent native = CreateNative(leaf, () => { });
        DurableApprovalAgent agent = new(native, (_, _) => ValueTask.CompletedTask);
        AgentSession session = await native.CreateSessionAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() => agent.RunAsync("start", session));
        Assert.Equal(0, leaf.Calls);
    }

    private static ChatClientAgent CreateNative(IChatClient leaf, Action execute) => new(leaf, new ChatClientAgentOptions
    {
        ChatOptions = new ChatOptions
        {
            Tools = [new ApprovalRequiredAIFunction(AIFunctionFactory.Create(() => { execute(); return "canonical-result"; }, "server_tool"))],
        },
    });

    private static JsonSerializerOptions JsonOptions()
    {
        JsonSerializerOptions options = new(AIJsonUtilities.DefaultOptions);
        options.TypeInfoResolverChain.Insert(0, AGUIJsonUtilities.DefaultTypeInfoResolver);
        return options;
    }

    private static async Task Run(DurableApprovalAgent agent, AgentSession session, List<ChatMessage> input, bool streaming)
    {
        if (streaming)
        {
            await foreach (AgentResponseUpdate _ in agent.RunStreamingAsync(input, session).ConfigureAwait(false))
            {
            }
        }
        else
        {
            await agent.RunAsync(input, session).ConfigureAwait(false);
        }
    }

    private sealed class TwoCallsClient : IChatClient
    {
        public int Calls { get; private set; }
        public string FirstToolName { get; init; } = "server_tool";
        public string SecondToolName { get; init; } = "server_tool";
        public List<ChatMessage>? LastInput { get; private set; }
        public Task<ChatResponse> GetResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default)
        {
            LastInput = messages.ToList();
            Calls++;
            return Task.FromResult(Calls == 1
                ? new ChatResponse(new ChatMessage(ChatRole.Assistant, [new FunctionCallContent("a", this.FirstToolName), new FunctionCallContent("b", this.SecondToolName)]))
                : new ChatResponse(new ChatMessage(ChatRole.Assistant, "done")));
        }
        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(IEnumerable<ChatMessage> messages, ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            foreach (ChatResponseUpdate update in (await this.GetResponseAsync(messages, options, cancellationToken).ConfigureAwait(false)).ToChatResponseUpdates())
            {
                yield return update;
            }
        }
        public object? GetService(Type serviceType, object? serviceKey = null) => null;
        public void Dispose() { }
    }
}
