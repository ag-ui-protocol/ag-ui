using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

/// <summary>
/// Characterizes issue #2815: a tool-approval resume whose payload matches the interrupt's own
/// advertised <c>responseSchema</c> (<c>{"approved":true}</c>) is not recognised as an approval,
/// because <c>RunAgentInputExtensions.TryDecodeToolApprovalResume</c> gates on the presence of a
/// <c>toolCall</c> echo that the schema never asks for.
/// </summary>
public sealed class ToolApprovalResumeWithoutEchoTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    private const string ThreadId = "thread-1";
    private const string RunId = "run-2";
    private const string InterruptId = "ficc_01";
    private const string CallId = "call_01";
    private const string ToolName = "delete_file";
    private const string ToolArgumentsJson = """{"path":"/tmp/file.txt"}""";

    private const string ApprovedWithEchoPayload =
        """
        {"approved":true,"toolCall":{"callId":"call_01","name":"delete_file","arguments":{"path":"/tmp/file.txt"}}}
        """;

    // ---------------------------------------------------------------------------------------
    // The reported defect.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// EXPECTED (per the reporter and per the interrupt's advertised responseSchema): a resume
    /// entry of <c>{interruptId, status:"resolved", payload:{approved:true}}</c>, sent on a thread
    /// whose messages still carry the unresolved approval-gated tool call, resumes THAT call —
    /// the adapter produces a ToolApprovalRequestContent/ToolApprovalResponseContent pair bound to
    /// call_01 so FunctionInvokingChatClient executes the tool.
    ///
    /// ACTUAL on this worktree: no approval content is produced at all. The entry falls through to
    /// a generic InterruptResponseContent, which FICC cannot match to the pending approval.
    /// </summary>
    [Fact]
    public void ResumeWithoutToolCallEcho_WhenHistoryCarriesThePendingCall_ShouldResumeThatApproval()
    {
        var context = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: true).ToChatRequestContext(SerializerOptions);

        var response = Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>());

        Assert.Equal(InterruptId, response.RequestId);
        Assert.True(response.Approved);
        Assert.Equal(CallId, Assert.IsType<FunctionCallContent>(response.ToolCall).CallId);
        Assert.Equal(ToolName, Assert.IsType<FunctionCallContent>(response.ToolCall).Name);
    }

    /// <summary>
    /// EXPECTED: the same resume entry does not ALSO arrive as a generic interrupt answer. A
    /// tool-approval interrupt answered as an approval is answered once, not twice.
    ///
    /// ACTUAL on this worktree: the only content produced is the generic
    /// InterruptResponseContent — the silent downgrade the issue describes.
    /// </summary>
    [Fact]
    public void ResumeWithoutToolCallEcho_WhenHistoryCarriesThePendingCall_ShouldNotDowngradeToGenericInterrupt()
    {
        var context = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: true).ToChatRequestContext(SerializerOptions);

        var generic = context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>()
            .Where(c => c.RequestId == InterruptId)
            .ToList();

        Assert.Empty(generic);
    }

    /// <summary>
    /// EXPECTED: a payload built from exactly the fields the server itself advertised on the
    /// interrupt's <c>responseSchema</c> is a valid answer to that interrupt. This test takes the
    /// schema off a real emitted interrupt rather than hardcoding it, so it pins the contradiction
    /// between what AGUI.Server promises on the way out and what it accepts on the way back in.
    ///
    /// ACTUAL on this worktree: the advertised schema is <c>{"required":["approved"]}</c> with no
    /// mention of <c>toolCall</c>, yet a payload carrying only <c>approved</c> is rejected.
    /// </summary>
    [Fact]
    public async Task PayloadBuiltFromTheAdvertisedResponseSchema_ShouldBeAcceptedAsAnApproval()
    {
        var interrupt = await EmitApprovalInterruptAsync();

        Assert.NotNull(interrupt.ResponseSchema);
        var required = interrupt.ResponseSchema!.Value.GetProperty("required")
            .EnumerateArray().Select(e => e.GetString()).ToList();
        var properties = interrupt.ResponseSchema!.Value.GetProperty("properties");

        // Build the answer the schema asks for, and nothing else.
        Assert.Equal(["approved"], required);
        Assert.False(properties.TryGetProperty("toolCall", out _));

        var payload = JsonDocument.Parse(
            "{" + string.Join(",", required.Select(name => $"\"{name}\":true")) + "}").RootElement.Clone();

        var context = new RunAgentInput
        {
            ThreadId = ThreadId,
            RunId = RunId,
            Messages = [PendingCallMessage()],
            Resume =
            [
                new AGUIResume
                {
                    InterruptId = interrupt.Id,
                    Status = ResumeStatus.Resolved,
                    Payload = payload,
                },
            ],
        }.ToChatRequestContext(SerializerOptions);

        Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>());
    }

    /// <summary>
    /// EXPECTED: a resume entry whose status is "cancelled" abandons the interrupt. It must never
    /// produce an approved ToolApprovalResponseContent, whatever its payload claims.
    ///
    /// ACTUAL on this worktree: <c>AGUIResume.Status</c> is never read by
    /// <c>TryDecodeToolApprovalResume</c>, so a cancelled entry carrying
    /// <c>{approved:true, toolCall:{…}}</c> approves and executes the tool.
    /// </summary>
    [Fact]
    public void CancelledResume_CarryingAnApprovedPayload_ShouldNotApproveTheToolCall()
    {
        var context = BuildResumeInput(
            payloadJson: ApprovedWithEchoPayload,
            includePendingCallInHistory: true,
            status: ResumeStatus.Cancelled).ToChatRequestContext(SerializerOptions);

        var approved = context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>()
            .Where(r => r.Approved)
            .ToList();

        Assert.Empty(approved);
    }

    // ---------------------------------------------------------------------------------------
    // Characterization of what works today, and of the limits of a history-based recovery.
    // These pass on this worktree and are here to bound the design question.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// Current behavior, passing: the full <c>toolCall</c> echo is the only resume payload shape
    /// AGUI.Server resolves to an approval today.
    /// </summary>
    [Fact]
    public void ResumeWithToolCallEcho_IsTheOnlyShapeThatResumesTheApprovalToday()
    {
        var context = BuildResumeInput(
            payloadJson: ApprovedWithEchoPayload,
            includePendingCallInHistory: true).ToChatRequestContext(SerializerOptions);

        var response = Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>());
        Assert.True(response.Approved);
        Assert.Equal(CallId, Assert.IsType<FunctionCallContent>(response.ToolCall).CallId);
    }

    /// <summary>
    /// Current behavior, passing: with no toolCall echo AND no message history, nothing in the
    /// request identifies the pending call. Any fix that recovers the call from the messages
    /// cannot help here; only carrying server-side state across the gap could. The spec requires
    /// the resuming run to carry the accumulated messages, so this input is already malformed.
    /// </summary>
    [Fact]
    public void ResumeWithoutEchoAndWithoutHistory_LeavesNothingToRecoverTheCallFrom()
    {
        var context = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: false).ToChatRequestContext(SerializerOptions);

        Assert.Empty(context.Messages.SelectMany(m => m.Contents).OfType<FunctionCallContent>());
        Assert.Single(context.Messages.SelectMany(m => m.Contents).OfType<InterruptResponseContent>());
    }

    /// <summary>
    /// Current behavior, passing: exactly one tool call in the history is unresolved, so a
    /// single-pending-approval recovery rule would be unambiguous for this input.
    /// </summary>
    [Fact]
    public void HistoryOnAResumingRun_CarriesExactlyOneUnresolvedToolCall()
    {
        var context = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: true).ToChatRequestContext(SerializerOptions);

        var contents = context.Messages.SelectMany(m => m.Contents).ToList();
        var resolved = contents.OfType<FunctionResultContent>().Select(r => r.CallId).ToHashSet(StringComparer.Ordinal);
        var unresolved = contents.OfType<FunctionCallContent>().Where(c => !resolved.Contains(c.CallId)).ToList();

        var pending = Assert.Single(unresolved);
        Assert.Equal(CallId, pending.CallId);
        Assert.Equal(ToolName, pending.Name);
    }

    // ---------------------------------------------------------------------------------------

    private static RunAgentInput BuildResumeInput(
        string payloadJson,
        bool includePendingCallInHistory,
        string? status = null) =>
        new()
        {
            ThreadId = ThreadId,
            RunId = RunId,
            Messages = includePendingCallInHistory ? [PendingCallMessage()] : [],
            Resume =
            [
                new AGUIResume
                {
                    InterruptId = InterruptId,
                    Status = status ?? ResumeStatus.Resolved,
                    Payload = JsonDocument.Parse(payloadJson).RootElement.Clone(),
                },
            ],
        };

    private static AGUIAssistantMessage PendingCallMessage() =>
        new()
        {
            Id = "msg-1",
            ToolCalls =
            [
                new AGUIToolCall
                {
                    Id = CallId,
                    Function = new AGUIToolCallFunction
                    {
                        Name = ToolName,
                        Arguments = ToolArgumentsJson,
                    },
                },
            ],
        };

    private static async Task<AGUIInterrupt> EmitApprovalInterruptAsync()
    {
        var toolCall = new FunctionCallContent(
            CallId,
            ToolName,
            new Dictionary<string, object?> { ["path"] = "/tmp/file.txt" });

        var context = new RunAgentInput { ThreadId = ThreadId, RunId = "run-1" }
            .ToChatRequestContext(SerializerOptions);

        var updates = ToAsyncEnumerable(new ChatResponseUpdate
        {
            Role = ChatRole.Assistant,
            Contents = [new ToolApprovalRequestContent(InterruptId, toolCall)],
        });

        var events = new List<BaseEvent>();
        await foreach (var evt in updates.AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        var finished = events.OfType<RunFinishedEvent>().Single();
        var outcome = Assert.IsType<RunFinishedInterruptOutcome>(finished.Outcome);
        return Assert.Single(outcome.Interrupts);
    }

    private static async IAsyncEnumerable<ChatResponseUpdate> ToAsyncEnumerable(
        params ChatResponseUpdate[] items)
    {
        foreach (var item in items)
        {
            yield return item;
        }

        await Task.CompletedTask.ConfigureAwait(false);
    }
}
