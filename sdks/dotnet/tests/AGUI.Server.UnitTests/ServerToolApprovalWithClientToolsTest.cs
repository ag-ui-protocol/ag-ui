using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

/// <summary>
/// Regression coverage for ag-ui#2820: declaring a client tool must not suppress the
/// approval interrupt for a server-side tool the client never declared.
///
/// The converter already discriminates by tool origin for the unwrap itself
/// (<c>clientToolNames.Contains(toolCall.Name)</c>), but the blanket guard that follows it
/// (<c>clientToolNames.Count > 0 &amp;&amp; !isContinuation</c>) drops every approval interrupt
/// on the first turn as soon as any client tool is declared, whatever its name. These tests
/// pin the discrimination rather than the symptom: the client tool keeps resolving to a plain
/// TOOL_CALL with <c>outcome: success</c>, while the server tool keeps its interrupt.
/// </summary>
public sealed class ServerToolApprovalWithClientToolsTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    private const string ThreadId = "thread-1";
    private const string RunId = "run-1";

    /// <summary>
    /// Control case: with no client tools declared, a server-tool approval request produces
    /// RUN_FINISHED(outcome: interrupt). This is the behaviour the reporter saw working.
    /// </summary>
    [Fact]
    public async Task ServerToolApproval_NoClientToolsDeclared_EmitsInterrupt()
    {
        var approval = new ToolApprovalRequestContent(
            "req-refund",
            new FunctionCallContent("call-refund", "IssueRefund",
                new Dictionary<string, object?> { ["amount"] = 42 }));

        var events = await CollectEvents(
            ToAsyncEnumerable(new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [approval] }),
            BuildContext());

        var finished = events.OfType<RunFinishedEvent>().Single();
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        var interrupt = Assert.Single(outcome.Interrupts);
        Assert.Equal("req-refund", interrupt.Id);
        Assert.Equal(InterruptReasons.ToolCall, interrupt.Reason);
        Assert.Equal("call-refund", interrupt.ToolCallId);
    }

    /// <summary>
    /// The bug: the same server-tool approval, with one unrelated client tool declared that the
    /// model never called, must still produce RUN_FINISHED(outcome: interrupt). On current main
    /// the run reports success and the approval request is silently discarded.
    /// </summary>
    [Fact]
    public async Task ServerToolApproval_UnrelatedClientToolDeclared_StillEmitsInterrupt()
    {
        var approval = new ToolApprovalRequestContent(
            "req-refund",
            new FunctionCallContent("call-refund", "IssueRefund",
                new Dictionary<string, object?> { ["amount"] = 42 }));

        var events = await CollectEvents(
            ToAsyncEnumerable(new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [approval] }),
            BuildContext("choose_option"));

        // The proposal itself is still streamed either way; the defect is in the terminal outcome.
        Assert.Equal("IssueRefund", events.OfType<ToolCallStartEvent>().Single().ToolCallName);

        var finished = events.OfType<RunFinishedEvent>().Single();
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        var interrupt = Assert.Single(outcome.Interrupts);
        Assert.Equal("req-refund", interrupt.Id);
        Assert.Equal(InterruptReasons.ToolCall, interrupt.Reason);
        Assert.Equal("call-refund", interrupt.ToolCallId);
    }

    /// <summary>
    /// The other half of the discrimination, which must keep working: an approval request for a
    /// tool the client declared is collateral from wrapping every tool in
    /// ApprovalRequiredAIFunction, so it unwraps to a plain TOOL_CALL and the run finishes
    /// successfully for the client to execute it.
    /// </summary>
    [Fact]
    public async Task ClientToolApproval_ClientToolDeclared_UnwrapsToPlainToolCall()
    {
        var approval = new ToolApprovalRequestContent(
            "req-choose",
            new FunctionCallContent("call-choose", "choose_option",
                new Dictionary<string, object?> { ["options"] = "a,b" }));

        var events = await CollectEvents(
            ToAsyncEnumerable(new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [approval] }),
            BuildContext("choose_option"));

        Assert.Equal("choose_option", events.OfType<ToolCallStartEvent>().Single().ToolCallName);

        var finished = events.OfType<RunFinishedEvent>().Single();
        Assert.IsType<RunFinishedSuccessOutcome>(finished.Outcome);
    }

    /// <summary>
    /// Both at once: the model proposes the declared client tool and a server tool requiring
    /// approval in the same response. The client tool unwraps, the server tool interrupts.
    /// </summary>
    [Fact]
    public async Task MixedApprovals_ClientToolUnwraps_ServerToolInterrupts()
    {
        var clientApproval = new ToolApprovalRequestContent(
            "req-choose",
            new FunctionCallContent("call-choose", "choose_option"));
        var serverApproval = new ToolApprovalRequestContent(
            "req-refund",
            new FunctionCallContent("call-refund", "IssueRefund"));

        var events = await CollectEvents(
            ToAsyncEnumerable(new ChatResponseUpdate
            {
                Role = ChatRole.Assistant,
                Contents = [clientApproval, serverApproval]
            }),
            BuildContext("choose_option"));

        Assert.Equal(
            new[] { "choose_option", "IssueRefund" },
            events.OfType<ToolCallStartEvent>().Select(e => e.ToolCallName).ToArray());

        var finished = events.OfType<RunFinishedEvent>().Single();
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        var interrupt = Assert.Single(outcome.Interrupts);
        Assert.Equal("req-refund", interrupt.Id);
        Assert.Equal("call-refund", interrupt.ToolCallId);
    }

    /// <summary>
    /// When one server tool requires approval, FunctionInvokingChatClient also wraps the plain
    /// server tools called alongside it (<c>RequiresConfirmation = false</c>). With no client
    /// tools declared, nothing else resumes those calls, so each one must still be surfaced as an
    /// interrupt. Driven through the real FICC: the plain ListFiles call must run after the resume.
    /// </summary>
    [Fact]
    public async Task RoundTrip_NoClientTools_PlainServerToolBesideApprovalStillRuns()
    {
        var deleteInvoked = false;
        var listInvoked = false;
        var serverTools = new List<AITool>
        {
            new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
                (string path) => { deleteInvoked = true; return $"deleted {path}"; }, "DeleteFile")),
            AIFunctionFactory.Create(() => { listInvoked = true; return "a.txt"; }, "ListFiles"),
        };

        var llm = new ScriptedChatClient(
            new FunctionCallContent("call-delete", "DeleteFile", new Dictionary<string, object?> { ["path"] = "a.txt" }),
            new FunctionCallContent("call-list", "ListFiles", new Dictionary<string, object?>()));

        var turn1 = await RunTurn(llm, serverTools, BuildInput([]));
        var interrupts = Assert.IsType<RunFinishedInterruptOutcome>(
            turn1.OfType<RunFinishedEvent>().Single().Outcome).Interrupts;
        Assert.Equal(2, interrupts.Count);

        await RunTurn(llm, serverTools, BuildResumeInput([], turn1, interrupts, _ => true, clientResults: []));

        Assert.True(deleteInvoked, "DeleteFile was approved and should run");
        Assert.True(listInvoked, "ListFiles was never gated and should run on resume");
        AssertEveryCallAnswered(llm.LastMessages!);
    }

    /// <summary>
    /// A client tool and a server tool requiring approval in the same response. The user denies
    /// the server tool on resume. The continuation that resolves the client tool's result must not
    /// re-approve the denied call: DeleteFile must not run.
    /// </summary>
    [Fact]
    public async Task RoundTrip_ClientToolBesideServerApproval_DenialIsHonoured()
    {
        var deleteInvoked = false;
        var serverTools = new List<AITool>
        {
            new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
                (string path) => { deleteInvoked = true; return $"deleted {path}"; }, "DeleteFile")),
        };

        var llm = new ScriptedChatClient(
            new FunctionCallContent("call-choose", "choose_option", new Dictionary<string, object?>()),
            new FunctionCallContent("call-delete", "DeleteFile", new Dictionary<string, object?> { ["path"] = "a.txt" }));

        var turn1 = await RunTurn(llm, serverTools, BuildInput(["choose_option"]));
        var interrupt = Assert.Single(Assert.IsType<RunFinishedInterruptOutcome>(
            turn1.OfType<RunFinishedEvent>().Single().Outcome).Interrupts);
        Assert.Equal("call-delete", interrupt.ToolCallId);

        await RunTurn(llm, serverTools, BuildResumeInput(
            ["choose_option"], turn1, [interrupt], _ => false,
            clientResults: new() { ["call-choose"] = "\"a\"" }));

        Assert.False(deleteInvoked, "DeleteFile was denied and must not run");
        AssertEveryCallAnswered(llm.LastMessages!);
    }

    private static RunAgentInput BuildInput(string[] clientToolNames) =>
        new()
        {
            ThreadId = ThreadId,
            RunId = RunId,
            Tools = clientToolNames
                .Select(name => new AGUITool
                {
                    Name = name,
                    Parameters = JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone()
                })
                .ToList(),
            Messages = [new AGUIUserMessage { Content = "tidy my files" }]
        };

    /// <summary>
    /// Builds the resume request a spec-following client sends: the history including the
    /// assistant's streamed tool calls and any client tool results, plus one echoed approval
    /// resume entry per interrupt.
    /// </summary>
    private static RunAgentInput BuildResumeInput(
        string[] clientToolNames,
        List<BaseEvent> turn1,
        IEnumerable<AGUIInterrupt> interrupts,
        Func<AGUIInterrupt, bool> approve,
        Dictionary<string, string> clientResults)
    {
        var input = BuildInput(clientToolNames);
        var args = turn1.OfType<ToolCallArgsEvent>().ToDictionary(e => e.ToolCallId, e => e.Delta);
        var calls = turn1.OfType<ToolCallStartEvent>().ToDictionary(e => e.ToolCallId, e => e.ToolCallName);
        var messages = new List<AGUIMessage>(input.Messages)
        {
            new AGUIAssistantMessage
            {
                ToolCalls = calls.Select(c => new AGUIToolCall
                {
                    Id = c.Key,
                    Function = new AGUIToolCallFunction { Name = c.Value, Arguments = args[c.Key] }
                }).ToList()
            }
        };
        foreach (var r in clientResults)
        {
            messages.Add(new AGUIToolMessage { ToolCallId = r.Key, Content = r.Value });
        }

        input.Messages = messages;
        input.Resume = interrupts.Select(i => new AGUIResume
        {
            InterruptId = i.Id,
            Status = ResumeStatus.Resolved,
            Payload = JsonDocument.Parse(
                $$$"""{"approved":{{{(approve(i) ? "true" : "false")}}},"toolCall":{"callId":"{{{i.ToolCallId}}}","name":"{{{calls[i.ToolCallId!]}}}","arguments":{{{args[i.ToolCallId!]}}}}}""")
                .RootElement.Clone(),
        }).ToList();
        return input;
    }

    private static async Task<List<BaseEvent>> RunTurn(
        ScriptedChatClient llm, IList<AITool> serverTools, RunAgentInput input)
    {
        var context = input.ToChatRequestContext(SerializerOptions);
        context.ChatOptions.Tools ??= new List<AITool>();
        foreach (var tool in serverTools)
        {
            context.ChatOptions.Tools.Add(tool);
        }

        var ficc = new ChatClientBuilder(llm).UseFunctionInvocation().Build();
        return await CollectEvents(
            ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions), context).ConfigureAwait(false);
    }

    private static void AssertEveryCallAnswered(IEnumerable<ChatMessage> messages)
    {
        var contents = messages.SelectMany(m => m.Contents).ToList();
        var answered = contents.OfType<FunctionResultContent>().Select(r => r.CallId).ToHashSet();
        foreach (var call in contents.OfType<FunctionCallContent>())
        {
            Assert.Contains(call.CallId, answered);
        }
    }

    /// <summary>
    /// A fake model: the first call proposes the given tool calls, every later call answers with
    /// text and records the messages it was sent.
    /// </summary>
    private sealed class ScriptedChatClient(params AIContent[] firstTurnCalls) : IChatClient
    {
        private int _calls;

        public List<ChatMessage>? LastMessages { get; private set; }

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            if (_calls++ == 0)
            {
                yield return new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents = [.. firstTurnCalls],
                    FinishReason = ChatFinishReason.ToolCalls,
                };
                yield break;
            }

            LastMessages = messages.ToList();
            yield return new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [new TextContent("done")] };
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }

    private static async Task<List<BaseEvent>> CollectEvents(
        IAsyncEnumerable<ChatResponseUpdate> updates,
        ChatRequestContext context)
    {
        var events = new List<BaseEvent>();
        await foreach (var evt in updates.AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    /// <summary>
    /// A first-turn request (no tool results in the history, so not a continuation) declaring the
    /// given client tools.
    /// </summary>
    private static ChatRequestContext BuildContext(params string[] clientToolNames) =>
        new RunAgentInput
        {
            ThreadId = ThreadId,
            RunId = RunId,
            Tools = clientToolNames
                .Select(name => new AGUITool
                {
                    Name = name,
                    Parameters = JsonDocument.Parse("""{"type":"object"}""").RootElement.Clone()
                })
                .ToList(),
            Messages = [new AGUIUserMessage { Content = "refund my order" }]
        }.ToChatRequestContext(SerializerOptions);

    private static async IAsyncEnumerable<ChatResponseUpdate> ToAsyncEnumerable(
        params ChatResponseUpdate[] items)
    {
        foreach (var item in items)
        {
            yield return item;
            await Task.Yield();
        }
    }
}
