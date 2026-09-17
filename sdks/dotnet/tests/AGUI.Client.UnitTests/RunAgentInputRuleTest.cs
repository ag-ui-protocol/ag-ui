using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

/// <summary>
/// What the client puts on the wire before a run starts: the protocol version it declares,
/// and the resume list it is allowed to send.
/// </summary>
public sealed class RunAgentInputRuleTest
{
    // ────────────────────────────────────────────────
    // The in-band version declaration
    // ────────────────────────────────────────────────

    // "a consumer implementing this version MUST declare the version it speaks here, unless
    // it knows its peer predates the" field (run-input.mdx, protocolVersion).
    [Fact]
    public async Task Request_DeclaresTheProtocolVersionItSpeaks()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new() { Transport = transport });

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "hi")]));

        Assert.Equal("1.0", transport.LastInput!.ProtocolVersion);
        Assert.Equal(AGUIChatClient.WireProtocolVersion, transport.LastInput!.ProtocolVersion);
    }

    // A peer pinned below the line this client speaks predates the field entirely, and an
    // unrecognised input member is exactly what a strict old parser could reject.
    [Fact]
    public async Task Request_PeerPinnedBelowTheLine_OmitsTheDeclaration()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new()
        {
            Transport = transport,
            MaxProtocolVersion = "0.0.57",
        });

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "hi")]));

        Assert.Null(transport.LastInput!.ProtocolVersion);
    }

    [Fact]
    public async Task Request_PeerAtTheLine_DeclaresIt()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new()
        {
            Transport = transport,
            MaxProtocolVersion = "1.0",
        });

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "hi")]));

        Assert.Equal("1.0", transport.LastInput!.ProtocolVersion);
    }

    // Silence about a peer is not evidence that it is old: a ceiling this client cannot
    // read must not silently downgrade the declaration.
    [Fact]
    public async Task Request_UnreadablePeerCeiling_DeclaresIt()
    {
        var transport = new CapturingTransport();
        using var client = new AGUIChatClient(new()
        {
            Transport = transport,
            MaxProtocolVersion = "whenever",
        });

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "hi")]));

        Assert.Equal("1.0", transport.LastInput!.ProtocolVersion);
    }

    // ────────────────────────────────────────────────
    // The resume list, against the interrupts of the run being continued
    // ────────────────────────────────────────────────

    // The conforming case: every interrupt the closing RUN_FINISHED delivered is answered,
    // and the run goes out.
    [Fact]
    public async Task Resume_CoveringEveryPendingInterrupt_IsSent()
    {
        var transport = new InterruptingTransport(Interrupt("i1"), Interrupt("i2"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));
        await DrainAsync(client.GetStreamingResponseAsync(
            [
                new ChatMessage(ChatRole.User, "go"),
                new ChatMessage(ChatRole.User,
                [
                    new InterruptResponseContent("i1"),
                    new InterruptResponseContent("i2"),
                ]),
            ],
            options));

        var resume = transport.Inputs[^1].Resume;
        Assert.NotNull(resume);
        Assert.Equal(["i1", "i2"], resume!.Select(entry => entry.InterruptId));
    }

    // "A consumer MUST reject a resuming input that leaves an interrupt uncovered before the
    // run starts — before anything is sent" (interrupt-resume.mdx).
    [Fact]
    public async Task Resume_LeavingAnInterruptUncovered_IsRejectedBeforeSending()
    {
        var transport = new InterruptingTransport(Interrupt("i1"), Interrupt("i2"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => DrainAsync(
            client.GetStreamingResponseAsync(
                [
                    new ChatMessage(ChatRole.User, "go"),
                    new ChatMessage(ChatRole.User, [new InterruptResponseContent("i1")]),
                ],
                options)));

        Assert.Contains("not addressed by 'resume': i2", ex.Message, StringComparison.Ordinal);
        // "before anything is sent": the second run never reached the transport.
        Assert.Single(transport.Inputs);
    }

    // An entry naming an interrupt the run did not raise is a violation the page names as
    // such; the tolerance quoted for it belongs to the producer's error handling, not to the
    // consumer assembling the list.
    [Fact]
    public async Task Resume_NamingAnInterruptTheRunDidNotRaise_IsRejected()
    {
        var transport = new InterruptingTransport(Interrupt("i1"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => DrainAsync(
            client.GetStreamingResponseAsync(
                [
                    new ChatMessage(ChatRole.User, "go"),
                    new ChatMessage(ChatRole.User,
                    [
                        new InterruptResponseContent("i1"),
                        new InterruptResponseContent("i-never-raised"),
                    ]),
                ],
                options)));

        Assert.Contains("did not raise: i-never-raised", ex.Message, StringComparison.Ordinal);
        Assert.Single(transport.Inputs);
    }

    // Two entries for one id cannot both be answers, and a set-based coverage check would
    // let the duplicate stand in for an interrupt nobody answered.
    [Fact]
    public async Task Resume_AnsweringOneInterruptTwice_IsRejected()
    {
        var transport = new InterruptingTransport(Interrupt("i1"), Interrupt("i2"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => DrainAsync(
            client.GetStreamingResponseAsync(
                [
                    new ChatMessage(ChatRole.User, "go"),
                    new ChatMessage(ChatRole.User,
                    [
                        new InterruptResponseContent("i1"),
                        new InterruptResponseContent("i1"),
                    ]),
                ],
                options)));

        Assert.Contains("answers interrupt 'i1' more than once", ex.Message, StringComparison.Ordinal);
        Assert.Single(transport.Inputs);
    }

    // "an interrupt the consumer judges expired can no longer be answered — the consumer
    // rejects a resume entry resolving it before the run starts."
    [Fact]
    public async Task Resume_ResolvingAnExpiredInterrupt_IsRejected()
    {
        var transport = new InterruptingTransport(Expired("i1"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));

        var ex = await Assert.ThrowsAsync<InvalidOperationException>(() => DrainAsync(
            client.GetStreamingResponseAsync(
                [
                    new ChatMessage(ChatRole.User, "go"),
                    new ChatMessage(ChatRole.User, [new InterruptResponseContent("i1")]),
                ],
                options)));

        Assert.Contains("can no longer be resolved", ex.Message, StringComparison.Ordinal);
        Assert.Single(transport.Inputs);
    }

    // "It can still be — and, coverage being mandatory, must be — abandoned, which is how a
    // thread moves past an interrupt nobody answered in time." Rejecting an expired
    // interrupt on presence alone would block its thread forever.
    [Fact]
    public async Task Resume_CancellingAnExpiredInterrupt_IsAccepted()
    {
        var transport = new InterruptingTransport(Expired("i1"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));

        var resuming = new ChatOptions
        {
            ConversationId = "t1",
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Resume = [new AGUIResume { InterruptId = "i1", Status = ResumeStatus.Cancelled }],
            },
        };
        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], resuming));

        var entry = Assert.Single(transport.Inputs[^1].Resume!);
        Assert.Equal(ResumeStatus.Cancelled, entry.Status);
    }

    // An interrupt whose expiry is still ahead is answerable as usual.
    [Fact]
    public async Task Resume_ResolvingAnUnexpiredInterrupt_IsAccepted()
    {
        var transport = new InterruptingTransport(
            Interrupt("i1", DateTimeOffset.UtcNow.AddHours(1).ToString("O", CultureInfo.InvariantCulture)));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));
        await DrainAsync(client.GetStreamingResponseAsync(
            [
                new ChatMessage(ChatRole.User, "go"),
                new ChatMessage(ChatRole.User, [new InterruptResponseContent("i1")]),
            ],
            options));

        Assert.Equal("i1", Assert.Single(transport.Inputs[^1].Resume!).InterruptId);
    }

    // `expiresAt` is format-unconstrained, so a value that is not a date leaves the
    // interrupt looking permanently unexpired rather than permanently unanswerable.
    [Fact]
    public async Task Resume_InterruptWithAnUnreadableExpiry_IsStillAnswerable()
    {
        var transport = new InterruptingTransport(Interrupt("i1", "whenever"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));
        await DrainAsync(client.GetStreamingResponseAsync(
            [
                new ChatMessage(ChatRole.User, "go"),
                new ChatMessage(ChatRole.User, [new InterruptResponseContent("i1")]),
            ],
            options));

        Assert.Equal("i1", Assert.Single(transport.Inputs[^1].Resume!).InterruptId);
    }

    // A run that closed without an interrupt outcome leaves the thread pending nothing, so
    // the next run is an ordinary new run and its resume list is not measured against a
    // previous run's interrupts.
    [Fact]
    public async Task Resume_AfterARunThatClosedWithoutInterrupts_IsNotChecked()
    {
        var transport = new InterruptingTransport(Interrupt("i1"));
        using var client = new AGUIChatClient(new() { Transport = transport });
        var options = new ChatOptions { ConversationId = "t1" };

        // Turn 1 interrupts, turn 2 answers it and closes cleanly, turn 3 is an ordinary run
        // carrying a resume entry for an interrupt nobody is waiting on any more.
        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], options));
        await DrainAsync(client.GetStreamingResponseAsync(
            [
                new ChatMessage(ChatRole.User, "go"),
                new ChatMessage(ChatRole.User, [new InterruptResponseContent("i1")]),
            ],
            options));

        var third = new ChatOptions
        {
            ConversationId = "t1",
            RawRepresentationFactory = _ => new RunAgentInput
            {
                Resume = [new AGUIResume { InterruptId = "anything", Status = ResumeStatus.Resolved }],
            },
        };
        await DrainAsync(client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "go")], third));

        Assert.Equal("anything", Assert.Single(transport.Inputs[^1].Resume!).InterruptId);
    }

    // Threads do not borrow each other's pending interrupts: a client instance serves every
    // conversation its caller opens.
    [Fact]
    public async Task Resume_PendingInterruptsAreScopedToTheirThread()
    {
        var transport = new InterruptingTransport(Interrupt("i1"));
        using var client = new AGUIChatClient(new() { Transport = transport });

        await DrainAsync(client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "go")], new ChatOptions { ConversationId = "t1" }));

        // A different conversation: nothing is pending on it, so no coverage rule applies.
        await DrainAsync(client.GetStreamingResponseAsync(
            [new ChatMessage(ChatRole.User, "go")], new ChatOptions { ConversationId = "t2" }));

        Assert.Equal("t2", transport.Inputs[^1].ThreadId);
    }

    // ────────────────────────────────────────────────
    // Plumbing
    // ────────────────────────────────────────────────

    private static AGUIInterrupt Interrupt(string id, string? expiresAt = null) =>
        new() { Id = id, Reason = "ask", Message = "answer me", ExpiresAt = expiresAt };

    private static AGUIInterrupt Expired(string id) =>
        Interrupt(id, DateTimeOffset.UtcNow.AddHours(-1).ToString("O", CultureInfo.InvariantCulture));

    private static async Task DrainAsync(IAsyncEnumerable<ChatResponseUpdate> updates)
    {
        await foreach (var _ in updates.ConfigureAwait(false))
        {
        }
    }

    /// <summary>
    /// Echoes the request's ids like a real stateless AG-UI server, and ends its FIRST run
    /// with the interrupt outcome it was constructed with. Later runs close cleanly, which
    /// is what leaves the thread pending nothing again.
    /// </summary>
    private sealed class InterruptingTransport(params AGUIInterrupt[] interrupts) : IAGUITransport
    {
        private int _turn;

        public List<RunAgentInput> Inputs { get; } = [];

        public async IAsyncEnumerable<BaseEvent> SendAsync(
            RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            Inputs.Add(input);
            var first = _turn++ == 0;

            yield return new RunStartedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
            yield return new RunFinishedEvent
            {
                ThreadId = input.ThreadId,
                RunId = input.RunId,
                Outcome = first && interrupts.Length > 0
                    ? new RunFinishedInterruptOutcome { Interrupts = [.. interrupts] }
                    : null,
            };

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }

    private sealed class CapturingTransport : IAGUITransport
    {
        public RunAgentInput? LastInput { get; private set; }

        public async IAsyncEnumerable<BaseEvent> SendAsync(
            RunAgentInput input, [EnumeratorCancellation] CancellationToken cancellationToken)
        {
            LastInput = input;

            yield return new RunStartedEvent { ThreadId = input.ThreadId, RunId = input.RunId };
            yield return new RunFinishedEvent { ThreadId = input.ThreadId, RunId = input.RunId };

            await Task.CompletedTask.ConfigureAwait(false);
        }
    }
}
