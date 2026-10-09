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
    /// The regression guard the old blanket guard was standing in for: when one tool in the
    /// response requires approval, FunctionInvokingChatClient wraps the peer server-side calls as
    /// <see cref="ToolApprovalRequestContent"/> too, with
    /// <c>RequiresConfirmation = false</c>. Those are collateral — the tool was never marked
    /// approval-required — so they must unwrap to a plain TOOL_CALL and leave the run successful.
    /// </summary>
    [Fact]
    public async Task ServerToolApproval_CollateralWrapWithoutConfirmation_DoesNotInterrupt()
    {
        var collateral = new ToolApprovalRequestContent(
            "req-lookup",
            new FunctionCallContent("call-lookup", "LookupOrder",
                new Dictionary<string, object?> { ["orderId"] = "o-1" }))
        {
#pragma warning disable MEAI001
            RequiresConfirmation = false,
#pragma warning restore MEAI001
        };

        var events = await CollectEvents(
            ToAsyncEnumerable(new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [collateral] }),
            BuildContext());

        // The call is still proposed to the client; only the interrupt is withheld.
        Assert.Equal("LookupOrder", events.OfType<ToolCallStartEvent>().Single().ToolCallName);

        var finished = events.OfType<RunFinishedEvent>().Single();
        Assert.IsType<RunFinishedSuccessOutcome>(finished.Outcome);
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
