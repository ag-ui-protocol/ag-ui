using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using AGUI.Abstractions;
using AGUI.Client;
using Microsoft.Extensions.AI;
using Xunit;

namespace AGUI.Client.UnitTests;

/// <summary>
/// The SHOULD-warn rules: the places where the specification asks a consumer to speak up
/// about material it is skipping or losing rather than let the loss look like something the
/// producer never sent.
/// </summary>
/// <remarks>
/// The .NET SDK has no logger — its warnings are <see cref="Trace.TraceWarning(string)"/>
/// calls carrying the <c>[ag-ui]</c> prefix — and <see cref="Trace.Listeners"/> is a
/// process-global collection with no per-test scope. This class therefore joins the
/// conformance lane's non-parallel collection, which is the tightest scope the Trace API
/// allows; see <see cref="ConformanceStreamCollection"/> for the full reasoning.
/// </remarks>
[Collection(ConformanceStreamCollection.Name)]
public sealed class ClientWarningTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    // ────────────────────────────────────────────────
    // Protocol version declared by the producer
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
            new RunStartedEvent { ThreadId = "t1", RunId = "r1", ProtocolVersion = AGUIChatClient.WireProtocolVersion },
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

    // ────────────────────────────────────────────────
    // ACTIVITY_DELTA naming a target that does not exist
    // ────────────────────────────────────────────────

    // "A delta naming a message that does not exist … is skipped; the consumer SHOULD
    // surface a warning, and MUST NOT fail the run" (activity.mdx).
    [Fact]
    public async Task ActivityDeltaWithNoSnapshot_WarnsAndDoesNotFailTheRun()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivityDeltaEvent
            {
                MessageId = "never-created",
                ActivityType = "web_search",
                Patch = Json("""[{"op":"replace","path":"/found","value":3}]"""),
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Contains(warnings, w => w.Contains("never-created", StringComparison.Ordinal));
    }

    // The other half of the same clause: skipped means skipped. The delta does not conjure
    // the activity message it names.
    [Fact]
    public async Task ActivityDeltaWithNoSnapshot_CreatesNoMessage()
    {
        var updates = new List<ChatResponseUpdate>();
        await ReplayAsync(
            updates,
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivityDeltaEvent
            {
                MessageId = "never-created",
                ActivityType = "web_search",
                Patch = Json("""[{"op":"replace","path":"/found","value":3}]"""),
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.DoesNotContain(
            updates.ToChatResponse().Messages,
            message => message.MessageId == "never-created");
    }

    [Fact]
    public async Task ActivityDeltaAfterItsSnapshot_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ActivitySnapshotEvent
            {
                MessageId = "act-1",
                ActivityType = "web_search",
                Content = Json("""{"query":"ag-ui","found":0}"""),
            },
            new ActivityDeltaEvent
            {
                MessageId = "act-1",
                ActivityType = "web_search",
                Patch = Json("""[{"op":"replace","path":"/found","value":3}]"""),
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    // ────────────────────────────────────────────────
    // A multimodal tool result flattened to text
    // ────────────────────────────────────────────────

    [Fact]
    public async Task MultimodalToolResult_WarnsOnceNamingWhatWasDropped()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            MultimodalResult("call-1"),
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        var flattening = warnings
            .Where(w => w.Contains("flattened to text", StringComparison.Ordinal))
            .ToList();
        var only = Assert.Single(flattening);
        Assert.Contains("call-1", only, StringComparison.Ordinal);
        Assert.Contains("1 non-text part(s)", only, StringComparison.Ordinal);
    }

    // Once per RESULT, not once per part and not once per consumer of the update.
    [Fact]
    public async Task TwoMultimodalToolResults_WarnOncePerResult()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            MultimodalResult("call-1"),
            MultimodalResult("call-2"),
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Equal(
            2,
            warnings.Count(w => w.Contains("flattened to text", StringComparison.Ordinal)));
    }

    // The text survives: the projection is what the warning is about, not a replacement for
    // it.
    [Fact]
    public async Task MultimodalToolResult_StillProjectsItsText()
    {
        var updates = new List<ChatResponseUpdate>();
        await ReplayAsync(
            updates,
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            MultimodalResult("call-1"),
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        var result = Assert.Single(
            updates.SelectMany(u => u.Contents).OfType<FunctionResultContent>());
        Assert.Equal("Invoice attached.", result.Result);
    }

    // A result that had nothing to drop must not claim it dropped something.
    [Fact]
    public async Task TextOnlyToolResult_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallResultEvent
            {
                MessageId = "tm-1",
                ToolCallId = "call-1",
                Content = "just text",
                Role = AGUIRoles.Tool,
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    // A parts list that happens to hold only text parts is not lossy either.
    [Fact]
    public async Task AllTextPartsToolResult_IsQuiet()
    {
        var warnings = await ReplayAsync(
            new RunStartedEvent { ThreadId = "t1", RunId = "r1" },
            new ToolCallResultEvent
            {
                MessageId = "tm-1",
                ToolCallId = "call-1",
                Content = new List<AGUIInputContent>
                {
                    new AGUITextInputContent { Text = "first " },
                    new AGUITextInputContent { Text = "second" },
                },
                Role = AGUIRoles.Tool,
            },
            new RunFinishedEvent { ThreadId = "t1", RunId = "r1" });

        Assert.Empty(warnings);
    }

    // ────────────────────────────────────────────────
    // Plumbing
    // ────────────────────────────────────────────────

    private static ToolCallResultEvent MultimodalResult(string toolCallId) =>
        new()
        {
            MessageId = "tm-" + toolCallId,
            ToolCallId = toolCallId,
            Content = new List<AGUIInputContent>
            {
                new AGUITextInputContent { Text = "Invoice attached." },
                new AGUIDocumentInputContent
                {
                    Id = "doc-" + toolCallId,
                    Source = new AGUIInputContentUrlSource
                    {
                        Value = "https://example.com/invoice.pdf",
                        MimeType = "application/pdf",
                    },
                },
            },
            Role = AGUIRoles.Tool,
        };

    private static JsonElement Json(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static async Task<List<string>> ReplayAsync(params BaseEvent[] events)
    {
        var updates = new List<ChatResponseUpdate>();
        return await ReplayAsync(updates, events).ConfigureAwait(false);
    }

    private static async Task<List<string>> ReplayAsync(List<ChatResponseUpdate> updates, params BaseEvent[] events)
    {
        var warnings = new List<string>();
        var listener = new AGUIWarningListener(warnings);
        Trace.Listeners.Add(listener);
        try
        {
            await foreach (var update in EventStreamConverter
                .AsChatResponseUpdates(Replay(events), s_options)
                .ConfigureAwait(false))
            {
                updates.Add(update);
            }
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }

        return warnings;
    }

#pragma warning disable CS1998 // the sequence is synchronous; the converter wants IAsyncEnumerable
    private static async IAsyncEnumerable<BaseEvent> Replay(BaseEvent[] events)
#pragma warning restore CS1998
    {
        foreach (var evt in events)
        {
            yield return evt;
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
