using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// <see cref="Trace.Listeners"/> is process-global with no per-test scope, so
/// every suite that reads the SDK's warnings shares one non-parallel collection.
/// </summary>
[CollectionDefinition(WireGuardCollection.Name, DisableParallelization = true)]
public sealed class WireGuardCollection
{
    public const string Name = "abstractions-trace-warnings";
}

/// <summary>
/// What the models do with a document the schema rejects, and what they say
/// about one the pre-1.0 shim still accepts.
/// </summary>
[Collection(WireGuardCollection.Name)]
public sealed class WireGuardTest
{
    // ────────────────────────────────────────────────
    // Required arbitrary-JSON payloads: absent is fatal, null is a value
    // ────────────────────────────────────────────────

    [Theory]
    [InlineData("""{"type":"CUSTOM","name":"n"}""", "value")]
    [InlineData("""{"type":"STATE_SNAPSHOT"}""", "snapshot")]
    [InlineData("""{"type":"RAW"}""", "event")]
    [InlineData("""{"type":"ACTIVITY_DELTA","activityId":"a"}""", "patch")]
    [InlineData("""{"type":"STATE_DELTA"}""", "delta")]
    public void RequiredPayload_Absent_IsFatal(string json, string field)
    {
        var error = Assert.Throws<JsonException>(() => Deserialize(json));
        Assert.Contains($"'{field}' is required", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RequiredPayload_ExplicitNull_IsValidAndSurvivesTheRoundTrip()
    {
        // DEPRECATIONS.md pins this: a null in a REQUIRED JSON payload is a
        // value, not the deprecated whole-field null, and stays on the wire.
        var custom = Assert.IsType<CustomEvent>(Deserialize("""{"type":"CUSTOM","name":"n","value":null}"""));

        Assert.Equal(JsonValueKind.Null, custom.Value.ValueKind);
        Assert.Equal(
            """{"type":"CUSTOM","name":"n","value":null}""",
            JsonSerializer.Serialize(custom, AGUIJsonSerializerContext.Default.BaseEvent));
    }

    [Fact]
    public void RequiredPayload_NeverSet_ReadsAsUndefined()
    {
        // The model's spelling of "absent", which is what makes the check above
        // possible at all: before this, absent and null were the same C# null.
        Assert.Equal(JsonValueKind.Undefined, new CustomEvent { Name = "n" }.Value.ValueKind);
    }

    // ────────────────────────────────────────────────
    // Numeric, list and pattern constraints
    // ────────────────────────────────────────────────

    [Fact]
    public void TokenCount_BelowItsMinimum_IsFatal()
    {
        var error = Assert.Throws<JsonException>(() => Deserialize(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[{"inputTokens":-5}]}"""));

        Assert.Contains("'inputTokens' is -5", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TokenCount_AboveItsMaximum_IsFatal() =>
        Assert.Throws<JsonException>(() => Deserialize(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[{"totalTokens":9007199254740992}]}"""));

    [Fact]
    public void Timestamp_OutsideTheSafeIntegerRange_IsFatal() =>
        Assert.Throws<JsonException>(() => Deserialize(
            """{"type":"TEXT_MESSAGE_END","messageId":"m","timestamp":9007199254740992}"""));

    [Fact]
    public void AssigningAnOutOfRangeCountIsRejectedToo() =>
        Assert.Throws<JsonException>(() => new TokenUsage { InputTokens = -1 });

    [Fact]
    public void InterruptOutcome_WithNoInterrupts_IsFatal()
    {
        var error = Assert.Throws<JsonException>(() => Deserialize(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"interrupt","interrupts":[]}}"""));

        Assert.Contains("fewer than the 1", error.Message, StringComparison.Ordinal);
    }

    // ────────────────────────────────────────────────
    // JSON Patch structure
    // ────────────────────────────────────────────────

    [Theory]
    [InlineData("""{"type":"STATE_DELTA","delta":42}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":{"op":"add","path":"/a","value":1}}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[5]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":5,"path":"/a"}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"add","value":1}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"add","path":"/a"}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"move","path":"/a"}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"add","path":"a","value":1}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"remove","path":"/a~2b"}]}""")]
    [InlineData("""{"type":"ACTIVITY_DELTA","activityId":"a","patch":{}}""")]
    public void MalformedPatch_IsFatal(string json) =>
        Assert.Throws<JsonException>(() => Deserialize(json));

    [Theory]
    [InlineData("""{"type":"STATE_DELTA","delta":[]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"add","path":"","value":null}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"remove","path":"/a","value":1}]}""")]
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"increment","path":"/a","value":1}]}""")]
    public void WellFormedOrMerelyUnrecognisedPatch_IsAccepted(string json) => Deserialize(json);

    // ────────────────────────────────────────────────
    // The pre-1.0 whole-field nulls: accepted, and announced
    // ────────────────────────────────────────────────

    [Theory]
    [InlineData("""{"type":"TEXT_MESSAGE_END","messageId":"m","rawEvent":null}""", "TextMessageEndEvent.rawEvent")]
    [InlineData("""{"type":"RUN_FINISHED","threadId":"t","runId":"r","result":null}""", "RunFinishedEvent.result")]
    [InlineData(
        """{"type":"SUBAGENT_FINISHED","subagentRunId":"s","result":null}""",
        "SubagentFinishedEvent.result")]
    [InlineData(
        """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"state":null}}""",
        "RunAgentInput.state")]
    [InlineData(
        """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"forwardedProps":null}}""",
        "RunAgentInput.forwardedProps")]
    [InlineData(
        """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"n","description":"d","parameters":null}]}}""",
        "Tool.parameters")]
    [InlineData(
        """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"i","status":"resolved","payload":null}]}}""",
        "ResumeEntry.payload")]
    [InlineData(
        """{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"m","role":"user","content":[{"type":"image","source":{"type":"url","value":"https://x/y.png"},"metadata":null}]}]}""",
        "ImagePart.metadata")]
    public void DeprecatedWholeFieldNull_IsAcceptedAndAnnounced(string json, string expected)
    {
        var warnings = Capture(() => Deserialize(json));

        Assert.Contains(
            warnings,
            warning => warning.Contains($"Converting deprecated {expected}: null", StringComparison.Ordinal)
                && warning.Contains("DEPRECATIONS.md", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("""{"type":"TEXT_MESSAGE_END","messageId":"m"}""")]
    [InlineData("""{"type":"RUN_FINISHED","threadId":"t","runId":"r"}""")]
    [InlineData(
        """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[]}}""")]
    public void AbsentOptionalField_IsSilent(string json) => Assert.Empty(Capture(() => Deserialize(json)));

    [Theory]
    // A null UNDER an open key is data: metadata is open by key.
    [InlineData("""{"type":"TEXT_MESSAGE_END","messageId":"m","metadata":{"k":null}}""")]
    // A null a JSON Patch operation carries is the value being added.
    [InlineData("""{"type":"STATE_DELTA","delta":[{"op":"add","path":"/a","value":null}]}""")]
    // A null in a REQUIRED payload is one of that field's legal values.
    [InlineData("""{"type":"CUSTOM","name":"n","value":null}""")]
    [InlineData("""{"type":"STATE_SNAPSHOT","snapshot":null}""")]
    public void NullThatIsAValue_IsSilent(string json) => Assert.Empty(Capture(() => Deserialize(json)));

    [Fact]
    public void TheWarningsCanBeSilenced()
    {
        Environment.SetEnvironmentVariable("SUPPRESS_TRANSFORMATION_WARNINGS", "true");
        try
        {
            Assert.Empty(Capture(() => Deserialize(
                """{"type":"TEXT_MESSAGE_END","messageId":"m","rawEvent":null}""")));
        }
        finally
        {
            Environment.SetEnvironmentVariable("SUPPRESS_TRANSFORMATION_WARNINGS", null);
        }
    }

    private static BaseEvent? Deserialize(string json) =>
        JsonSerializer.Deserialize(json, AGUIJsonSerializerContext.Default.BaseEvent);

    private static List<string> Capture(Action action)
    {
        var warnings = new List<string>();
        var listener = new CompatWarningListener(warnings);
        Trace.Listeners.Add(listener);
        try
        {
            action();
        }
        finally
        {
            Trace.Listeners.Remove(listener);
        }

        return warnings;
    }

    private sealed class CompatWarningListener : TraceListener
    {
        private const string CompatPrefix = "[ag-ui][compat]";

        private readonly List<string> _warnings;

        public CompatWarningListener(List<string> warnings) => _warnings = warnings;

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
            TraceEventCache? eventCache,
            string source,
            TraceEventType eventType,
            int id,
            string? format,
            params object?[]? args) =>
            Record(
                eventType,
                format is null ? null : string.Format(CultureInfo.InvariantCulture, format, args ?? []));

        private void Record(TraceEventType eventType, string? message)
        {
            if (eventType == TraceEventType.Warning
                && message?.StartsWith(CompatPrefix, StringComparison.Ordinal) == true)
            {
                _warnings.Add(message);
            }
        }
    }
}
