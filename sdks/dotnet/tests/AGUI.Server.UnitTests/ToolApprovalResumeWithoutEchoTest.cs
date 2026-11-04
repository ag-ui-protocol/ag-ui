using System.Runtime.CompilerServices;
using System.Text.Json;
using AGUI.Abstractions;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Server.UnitTests;

/// <summary>
/// A tool-approval resume whose payload matches the interrupt's advertised <c>responseSchema</c>
/// (<c>{"approved":true}</c>, no <c>toolCall</c> echo) resumes the call its approval interrupt id
/// names, recovered from the run's messages. A payload that echoes <c>toolCall</c> still resumes
/// too, and a non-approval interrupt never resolves to an approval.
/// </summary>
public sealed class ToolApprovalResumeWithoutEchoTest
{
    private static readonly JsonSerializerOptions SerializerOptions = AIJsonUtilities.DefaultOptions;

    private const string ThreadId = "thread-1";
    private const string RunId = "run-2";
    // FunctionInvokingChatClient mints an approval request id of `ficc_<callId>`, and that id is
    // what the interrupt carries.
    private const string InterruptId = "ficc_call_01";
    private const string CallId = "call_01";
    private const string ToolName = "delete_file";
    private const string ToolArgumentsJson = """{"path":"/tmp/file.txt"}""";

    private const string ApprovedWithEchoPayload =
        """
        {"approved":true,"toolCall":{"callId":"call_01","name":"delete_file","arguments":{"path":"/tmp/file.txt"}}}
        """;

    // ---------------------------------------------------------------------------------------
    // Schema-shaped answers without a toolCall echo.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// A resume entry of <c>{interruptId, status:"resolved", payload:{approved:true}}</c>, sent on
    /// a thread whose messages still carry the unresolved approval-gated tool call, resumes that
    /// call: the adapter produces a ToolApprovalRequestContent/ToolApprovalResponseContent pair
    /// bound to call_01 so FunctionInvokingChatClient executes the tool.
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
    /// The same resume entry does not also arrive as a generic interrupt answer. A tool-approval
    /// interrupt answered as an approval is answered once, not twice.
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
    /// A payload built from exactly the fields the server advertised on the interrupt's
    /// <c>responseSchema</c> is a valid answer to that interrupt. The schema is taken off a real
    /// emitted interrupt rather than hardcoded, so what AGUI.Server promises on the way out and
    /// what it accepts on the way back in cannot drift apart.
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
    /// A resume entry whose status is "cancelled" abandons the interrupt. It never produces an
    /// approved ToolApprovalResponseContent, whatever its payload claims.
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
    // The toolCall echo, and the limits of a history-based recovery.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// A payload that echoes the full <c>toolCall</c> still resumes the approval.
    /// </summary>
    [Fact]
    public void ResumeWithToolCallEcho_StillResumesTheApproval()
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
    /// With no toolCall echo AND no message history, nothing in the request identifies the pending
    /// call. Recovering the call from the messages cannot help here; only carrying server-side
    /// state across the gap could. The spec requires the resuming run to carry the accumulated
    /// messages, so the input is rejected as naming a call the run does not carry, rather than
    /// quietly approving nothing.
    /// </summary>
    [Fact]
    public void ResumeWithoutEchoAndWithoutHistory_IsRejected()
    {
        var input = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: false);

        var ex = Assert.Throws<InvalidOperationException>(() => input.ToChatRequestContext(SerializerOptions));
        Assert.Contains(CallId, ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// The history of a resuming run carries exactly one unresolved tool call, the one the
    /// approval interrupt was raised for.
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
    // Several pending calls: each bare entry binds by its interrupt id.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// Two parallel approval interrupts, each answered with the schema-shaped
    /// <c>{approved}</c> payload. Each entry resolves to the call its interrupt was raised for.
    /// </summary>
    [Fact]
    public void ParallelBareEntries_EachBindToTheCallTheirInterruptWasRaisedFor()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true}"""),
            Resume("ficc_call_02", """{"approved":false}""")).ToChatRequestContext(SerializerOptions);

        var responses = ApprovalResponsesByCallId(context);
        Assert.Equal(2, responses.Count);
        Assert.True(responses["call_01"].Approved);
        Assert.False(responses["call_02"].Approved);
    }

    /// <summary>
    /// A bare entry listed before an entry that echoes its own call. Order must not matter: both
    /// calls resolve.
    /// </summary>
    [Fact]
    public void BareEntryBeforeEchoEntry_BothResolve()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true}"""),
            Resume("ficc_call_02", """
                {"approved":true,"toolCall":{"callId":"call_02","name":"delete_file","arguments":{"path":"/tmp/other.txt"}}}
                """)).ToChatRequestContext(SerializerOptions);

        var responses = ApprovalResponsesByCallId(context);
        Assert.Equal(2, responses.Count);
        Assert.True(responses["call_01"].Approved);
        Assert.True(responses["call_02"].Approved);
    }

    /// <summary>
    /// A bare entry and an echo entry that both answer call_01. The echo names its call, so it is
    /// resolved first and the call is answered exactly once, whatever order the entries came in.
    /// </summary>
    [Fact]
    public void BareEntryAndEchoEntryForTheSameCall_AnswerItOnce()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true}"""),
            Resume("echo-approval", ApprovedWithEchoPayload.Replace("true", "false", StringComparison.Ordinal)))
            .ToChatRequestContext(SerializerOptions);

        var response = Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>());
        Assert.Equal("echo-approval", response.RequestId);
        Assert.False(response.Approved);
    }

    /// <summary>
    /// An echo entry approving call_01 and a bare entry denying it. Both name the same call, so
    /// only the first one resolved answers it: the echo, since entries that name their call are
    /// resolved before bare ones. The bare entry stays a generic interrupt response.
    /// </summary>
    [Fact]
    public void EchoApproveAndBareDenyForTheSameCall_FirstResolvedEntryWins()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":false}"""),
            Resume("echo-approval", ApprovedWithEchoPayload)).ToChatRequestContext(SerializerOptions);

        var response = Assert.Single(ApprovalResponsesByCallId(context)).Value;
        Assert.Equal("echo-approval", response.RequestId);
        Assert.True(response.Approved);
        Assert.Equal("ficc_call_01", Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// An approval entry with a matching <c>toolCallId</c> and an echo entry for the same call. The
    /// <c>toolCallId</c> entry sorts ahead of the echo and answers the call once; the echo stays a
    /// generic interrupt response.
    /// </summary>
    [Fact]
    public void ToolCallIdEntryAndEchoEntryForTheSameCall_AnswerItOnce()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true,"toolCallId":"call_01"}"""),
            Resume("echo-approval", ApprovedWithEchoPayload)).ToChatRequestContext(SerializerOptions);

        var response = Assert.Single(ApprovalResponsesByCallId(context)).Value;
        Assert.Equal("ficc_call_01", response.RequestId);
        Assert.Equal("echo-approval", Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// A bare entry with no interrupt id is not an approval id, so it is handled like any other
    /// resume entry without an id: it falls through to the generic interrupt response, which
    /// rejects the missing request id. It never approves a call.
    /// </summary>
    [Fact]
    public void BareEntry_WithNullInterruptId_IsNotTreatedAsAnApproval()
    {
        var bare = BuildTwoCallResumeInput(Resume("placeholder", """{"approved":true}"""));
        bare.Resume![0].InterruptId = null!;
        var generic = BuildTwoCallResumeInput(Resume("placeholder", """{"answer":"yes"}"""));
        generic.Resume![0].InterruptId = null!;

        var bareEx = Assert.Throws<ArgumentNullException>(() => bare.ToChatRequestContext(SerializerOptions));
        var genericEx = Assert.Throws<ArgumentNullException>(() => generic.ToChatRequestContext(SerializerOptions));
        Assert.Equal(genericEx.ParamName, bareEx.ParamName);
    }

    /// <summary>
    /// An approval entry whose <c>toolCallId</c> matches its interrupt's call is accepted whatever
    /// its position, here after a bare entry for the other pending call.
    /// </summary>
    [Fact]
    public void ToolCallIdEntry_BindsTheNamedCall_WhateverItsPosition()
    {
        var context = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":false}"""),
            Resume("ficc_call_02", """{"approved":true,"toolCallId":"call_02"}""")).ToChatRequestContext(SerializerOptions);

        var responses = ApprovalResponsesByCallId(context);
        Assert.Equal(2, responses.Count);
        Assert.False(responses["call_01"].Approved);
        Assert.True(responses["call_02"].Approved);
        Assert.Equal("ficc_call_02", responses["call_02"].RequestId);
    }

    /// <summary>
    /// A bare entry whose interrupt id is an approval id for a tool call the run's messages do not
    /// carry at all. Same as a <c>toolCallId</c> naming an unknown call: the request is rejected
    /// rather than quietly approving nothing.
    /// </summary>
    [Fact]
    public void BareEntry_ForACallNotInTheHistory_Throws()
    {
        var input = BuildTwoCallResumeInput(
            Resume("ficc_call_99", """{"approved":true}"""));

        var ex = Assert.Throws<InvalidOperationException>(() => input.ToChatRequestContext(SerializerOptions));
        Assert.Contains("call_99", ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// A bare entry whose interrupt id names a call that is in the history but already has a
    /// result (a replayed resume). It approves nothing and stays a generic interrupt response.
    /// </summary>
    [Fact]
    public void BareEntry_ForAnAlreadyAnsweredCall_ApprovesNothing()
    {
        var input = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true}"""));
        input.Messages = [.. input.Messages, new AGUIToolMessage { ToolCallId = "call_01", Content = "deleted" }];

        var context = input.ToChatRequestContext(SerializerOptions);

        Assert.Empty(ApprovalResponsesByCallId(context));
        Assert.Equal("ficc_call_01", Assert.Single(context.Messages
            .SelectMany(m => m.Contents)
            .OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// A non-approval interrupt whose answer happens to carry an <c>approved</c> bool must not
    /// approve the single pending tool call.
    /// </summary>
    [Fact]
    public void NonApprovalInterrupt_WithApprovedField_DoesNotApproveThePendingCall()
    {
        var input = BuildResumeInput(
            payloadJson: """{"approved":true}""",
            includePendingCallInHistory: true);
        input.Resume![0].InterruptId = "confirm-plan";

        var contents = input.ToChatRequestContext(SerializerOptions).Messages.SelectMany(m => m.Contents).ToList();

        Assert.Empty(contents.OfType<ToolApprovalResponseContent>());
        Assert.Equal("confirm-plan", Assert.Single(contents.OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// A non-approval interrupt whose answer carries <c>approved</c> and a <c>toolCallId</c> naming
    /// the pending call stays a generic interrupt response, so its own handler gets the answer.
    /// </summary>
    [Fact]
    public void NonApprovalInterrupt_WithToolCallIdOfThePendingCall_StaysGeneric()
    {
        var input = BuildResumeInput(
            payloadJson: """{"approved":true,"toolCallId":"call_01"}""",
            includePendingCallInHistory: true);
        input.Resume![0].InterruptId = "confirm-plan";

        var contents = input.ToChatRequestContext(SerializerOptions).Messages.SelectMany(m => m.Contents).ToList();

        Assert.Empty(contents.OfType<ToolApprovalResponseContent>());
        Assert.Equal("confirm-plan", Assert.Single(contents.OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// A non-approval interrupt whose <c>toolCallId</c> names a call the messages do not carry is
    /// not an approval, so it is not rejected either: it stays a generic interrupt response.
    /// </summary>
    [Fact]
    public void NonApprovalInterrupt_WithToolCallIdNotInTheHistory_StaysGeneric()
    {
        var input = BuildResumeInput(
            payloadJson: """{"approved":true,"toolCallId":"call_zz"}""",
            includePendingCallInHistory: true);
        input.Resume![0].InterruptId = "confirm-plan";

        var contents = input.ToChatRequestContext(SerializerOptions).Messages.SelectMany(m => m.Contents).ToList();

        Assert.Empty(contents.OfType<ToolApprovalResponseContent>());
        Assert.Equal("confirm-plan", Assert.Single(contents.OfType<InterruptResponseContent>()).RequestId);
    }

    /// <summary>
    /// An approval interrupt is bound to its own call. A <c>toolCallId</c> naming a different call
    /// contradicts it, and the request is rejected naming both calls.
    /// </summary>
    [Fact]
    public void ApprovalInterrupt_WithToolCallIdOfAnotherCall_Throws()
    {
        var input = BuildTwoCallResumeInput(
            Resume("ficc_call_01", """{"approved":true,"toolCallId":"call_02"}"""));

        var ex = Assert.Throws<InvalidOperationException>(() => input.ToChatRequestContext(SerializerOptions));
        Assert.Contains("ficc_call_01", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'call_01'", ex.Message, StringComparison.Ordinal);
        Assert.Contains("'call_02'", ex.Message, StringComparison.Ordinal);
    }

    // ---------------------------------------------------------------------------------------
    // Round trip through the real FunctionInvokingChatClient. The interrupt id is taken from what
    // the server actually emitted rather than written out here, so if FICC ever mints approval
    // ids differently these fail instead of passing against a stale literal.
    // ---------------------------------------------------------------------------------------

    /// <summary>
    /// Turn 1 raises an approval interrupt through FICC. Turn 2 answers it with only
    /// <c>{approved:true}</c>, keyed by the emitted interrupt id, and the tool runs.
    /// </summary>
    [Fact]
    public async Task RoundTrip_BareApproval_KeyedByEmittedInterruptId_RunsTheTool()
    {
        var deleted = new List<string>();
        var tools = DeleteFileTool(deleted);
        var llm = new ScriptedChatClient(
            new FunctionCallContent("call-a", ToolName, new Dictionary<string, object?> { ["path"] = "a.txt" }));

        var turn1 = await RunTurnAsync(llm, tools, RoundTripInput());
        var interrupt = Assert.Single(Interrupts(turn1));

        await RunTurnAsync(llm, tools, RoundTripResumeInput(turn1, Resume(interrupt.Id, """{"approved":true}""")));

        Assert.Equal(["a.txt"], deleted);
    }

    /// <summary>
    /// Two parallel approval interrupts through FICC, one approved and one denied with bare
    /// entries. Exactly the approved call runs.
    /// </summary>
    [Fact]
    public async Task RoundTrip_ParallelBareAnswers_RunExactlyTheApprovedCall()
    {
        var deleted = new List<string>();
        var tools = DeleteFileTool(deleted);
        var llm = new ScriptedChatClient(
            new FunctionCallContent("call-a", ToolName, new Dictionary<string, object?> { ["path"] = "a.txt" }),
            new FunctionCallContent("call-b", ToolName, new Dictionary<string, object?> { ["path"] = "b.txt" }));

        var turn1 = await RunTurnAsync(llm, tools, RoundTripInput());
        var interrupts = Interrupts(turn1);
        Assert.Equal(2, interrupts.Count);
        var approve = interrupts.Single(i => i.ToolCallId == "call-a");
        var deny = interrupts.Single(i => i.ToolCallId == "call-b");

        await RunTurnAsync(llm, tools, RoundTripResumeInput(
            turn1,
            Resume(deny.Id, """{"approved":false}"""),
            Resume(approve.Id, """{"approved":true}""")));

        Assert.Equal(["a.txt"], deleted);
    }

    /// <summary>
    /// A <c>toolCallId</c> entry and an echo entry for the same call, through FICC. The tool runs
    /// once.
    /// </summary>
    [Fact]
    public async Task RoundTrip_ToolCallIdAndEchoForTheSameCall_RunTheToolOnce()
    {
        var deleted = new List<string>();
        var tools = DeleteFileTool(deleted);
        var llm = new ScriptedChatClient(
            new FunctionCallContent("call-a", ToolName, new Dictionary<string, object?> { ["path"] = "a.txt" }));

        var turn1 = await RunTurnAsync(llm, tools, RoundTripInput());
        var interrupt = Assert.Single(Interrupts(turn1));

        await RunTurnAsync(llm, tools, RoundTripResumeInput(
            turn1,
            Resume(interrupt.Id, """{"approved":true,"toolCallId":"call-a"}"""),
            Resume("echo-approval", """
                {"approved":true,"toolCall":{"callId":"call-a","name":"delete_file","arguments":{"path":"a.txt"}}}
                """)));

        Assert.Equal(["a.txt"], deleted);
    }

    private static List<AITool> DeleteFileTool(List<string> deleted) =>
    [
        new ApprovalRequiredAIFunction(AIFunctionFactory.Create(
            (string path) =>
            {
                deleted.Add(path);
                return $"deleted {path}";
            },
            ToolName)),
    ];

    private static RunAgentInput RoundTripInput() =>
        new()
        {
            ThreadId = ThreadId,
            RunId = "run-1",
            Messages = [new AGUIUserMessage { Id = "user-1", Content = "tidy my files" }],
        };

    /// <summary>
    /// The resume a client sends after turn 1: the history including the streamed tool calls, and
    /// the given resume entries. Nothing about the calls goes into the entries themselves.
    /// </summary>
    private static RunAgentInput RoundTripResumeInput(List<BaseEvent> turn1, params AGUIResume[] resume)
    {
        var args = turn1.OfType<ToolCallArgsEvent>().ToDictionary(e => e.ToolCallId, e => e.Delta);
        var input = RoundTripInput();
        input.RunId = RunId;
        input.Messages =
        [
            .. input.Messages,
            new AGUIAssistantMessage
            {
                Id = "assistant-1",
                ToolCalls = turn1.OfType<ToolCallStartEvent>().Select(e => new AGUIToolCall
                {
                    Id = e.ToolCallId,
                    Function = new AGUIToolCallFunction { Name = e.ToolCallName, Arguments = args[e.ToolCallId] },
                }).ToList(),
            },
        ];
        input.Resume = resume;
        return input;
    }

    private static IList<AGUIInterrupt> Interrupts(List<BaseEvent> events) =>
        Assert.IsType<RunFinishedInterruptOutcome>(events.OfType<RunFinishedEvent>().Single().Outcome).Interrupts;

    private static async Task<List<BaseEvent>> RunTurnAsync(
        ScriptedChatClient llm, List<AITool> tools, RunAgentInput input)
    {
        var context = input.ToChatRequestContext(SerializerOptions);
        context.ChatOptions.Tools = tools;

        var ficc = new ChatClientBuilder(llm).UseFunctionInvocation().Build();
        var events = new List<BaseEvent>();
        await foreach (var evt in ficc.GetStreamingResponseAsync(context.Messages, context.ChatOptions)
            .AsAGUIEventStreamAsync(context).ConfigureAwait(false))
        {
            events.Add(evt);
        }

        return events;
    }

    /// <summary>
    /// A fake model: the first call proposes the given tool calls, every later call answers with
    /// text.
    /// </summary>
    private sealed class ScriptedChatClient(params AIContent[] firstTurnCalls) : IChatClient
    {
        private int _calls;

        public async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
            IEnumerable<ChatMessage> messages,
            ChatOptions? options = null,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            yield return _calls++ == 0
                ? new ChatResponseUpdate
                {
                    Role = ChatRole.Assistant,
                    Contents = [.. firstTurnCalls],
                    FinishReason = ChatFinishReason.ToolCalls,
                }
                : new ChatResponseUpdate { Role = ChatRole.Assistant, Contents = [new TextContent("done")] };
        }

        public Task<ChatResponse> GetResponseAsync(
            IEnumerable<ChatMessage> messages, ChatOptions? options = null, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public object? GetService(Type serviceType, object? serviceKey = null) => null;

        public void Dispose()
        {
        }
    }

    private static AGUIResume Resume(string interruptId, string payloadJson) =>
        new()
        {
            InterruptId = interruptId,
            Status = ResumeStatus.Resolved,
            Payload = JsonDocument.Parse(payloadJson).RootElement.Clone(),
        };

    private static RunAgentInput BuildTwoCallResumeInput(params AGUIResume[] resume) =>
        new()
        {
            ThreadId = ThreadId,
            RunId = RunId,
            Messages =
            [
                new AGUIAssistantMessage
                {
                    Id = "msg-1",
                    ToolCalls =
                    [
                        new AGUIToolCall
                        {
                            Id = "call_01",
                            Function = new AGUIToolCallFunction { Name = ToolName, Arguments = ToolArgumentsJson },
                        },
                        new AGUIToolCall
                        {
                            Id = "call_02",
                            Function = new AGUIToolCallFunction { Name = ToolName, Arguments = """{"path":"/tmp/other.txt"}""" },
                        },
                    ],
                },
            ],
            Resume = resume,
        };

    private static Dictionary<string, ToolApprovalResponseContent> ApprovalResponsesByCallId(ChatRequestContext context) =>
        context.Messages
            .SelectMany(m => m.Contents)
            .OfType<ToolApprovalResponseContent>()
            .ToDictionary(r => Assert.IsType<FunctionCallContent>(r.ToolCall).CallId);

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
