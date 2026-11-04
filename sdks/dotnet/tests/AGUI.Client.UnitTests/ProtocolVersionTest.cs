using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
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
/// The in-band version handshake, on both sides: the version this client declares on the
/// request, and what it makes of the version a producer declares on <c>RUN_STARTED</c>.
/// </summary>
/// <remarks>
/// The .NET SDK has no logger — its warnings are <see cref="Trace.TraceWarning(string)"/>
/// calls carrying the <c>[ag-ui]</c> prefix — and <see cref="Trace.Listeners"/> is a
/// process-global collection with no per-test scope. This class therefore joins the
/// conformance lane's non-parallel collection, which is the tightest scope the Trace API
/// allows; see <see cref="ConformanceStreamCollection"/> for the full reasoning.
/// </remarks>
[Collection(ConformanceStreamCollection.Name)]
public sealed class ProtocolVersionTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    // ────────────────────────────────────────────────
    // The version this client declares on the request
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
        Assert.Equal(AGUIProtocol.Version, transport.LastInput!.ProtocolVersion);
    }



    // ────────────────────────────────────────────────
    // The version the producer declares on RUN_STARTED
    // ────────────────────────────────────────────────

    [Fact]
    public async Task ProducerDeclaresNewerVersion_Warns()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1", ProtocolVersion = "1.1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Contains(warnings, w => w.Contains("1.1", StringComparison.Ordinal));
    }

    // "a value outside the grammar is handled like a newer one, not silently accepted."
    [Fact]
    public async Task ProducerDeclaresUninterpretableVersion_Warns()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1", ProtocolVersion = "draft" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Contains(warnings, w => w.Contains("cannot interpret", StringComparison.Ordinal));
    }

    [Fact]
    public async Task ProducerDeclaresTheSameVersion_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1", ProtocolVersion = AGUIProtocol.Version },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    // Absent is a peer from before the protocol carried a version, which the versioning
    // rules expect a consumer to serve without comment.
    [Fact]
    public async Task ProducerDeclaresNoVersion_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    // An older declaration is the downgrade the rules expect a consumer to notice quietly:
    // nothing this client understands is at risk. Mirrors the TypeScript client, which
    // warns on "newer" and "uninterpretable" only.
    [Fact]
    public async Task ProducerDeclaresOlderVersion_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1", ProtocolVersion = "0.9" },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    private static async Task DrainAsync(IAsyncEnumerable<ChatResponseUpdate> updates)
    {
        await foreach (var _ in updates.ConfigureAwait(false))
        {
        }
    }

    private static async Task<List<string>> ReplayAsync(params BaseEvent[] events)
    {
        var warnings = new List<string>();
        var listener = new AGUIWarningListener(warnings);
        Trace.Listeners.Add(listener);
        try
        {
            await foreach (var _ in EventStreamConverter
                .AsChatResponseUpdates(Replay(events), s_options)
                .ConfigureAwait(false))
            {
            }
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }

        return warnings;
    }

#pragma warning disable CS1998
    private static async IAsyncEnumerable<BaseEvent> Replay(BaseEvent[] events)
#pragma warning restore CS1998
    {
        foreach (var evt in events)
        {
            yield return evt;
        }
    }

    /// <summary>
    /// Echoes the request's ids like a real stateless AG-UI server, and records the input it
    /// was sent so the declaration can be read off the wire.
    /// </summary>
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

    /// <summary>
    /// Records the SDK's own <c>[ag-ui]</c> warnings for the duration of one replay. Same
    /// shape and same bounds as the conformance lane's listener.
    /// </summary>
    private sealed class AGUIWarningListener : TraceListener
    {
        private const string AGUIPrefix = "[ag-ui]";

        private readonly List<string> _warnings;

        public AGUIWarningListener(List<string> warnings) => _warnings = warnings;

        public override void Write(string? message)
        {
        }

        public override void WriteLine(string? message)
        {
        }

        public override void TraceEvent(
            TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? message) =>
            Record(eventType, message);

        public override void TraceEvent(
            TraceEventCache? eventCache, string source, TraceEventType eventType, int id, string? format, params object?[]? args) =>
            Record(
                eventType,
                format is null || args is null
                    ? format
                    : string.Format(CultureInfo.InvariantCulture, format, args));

        private void Record(TraceEventType eventType, string? message)
        {
            if (eventType != TraceEventType.Warning
                || message is null
                || !message.Contains(AGUIPrefix, StringComparison.Ordinal))
            {
                return;
            }

            lock (_warnings)
            {
                _warnings.Add(message);
            }
        }
    }
}
