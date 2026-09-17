using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace AGUI.Abstractions.UnitTests;

/// <summary>
/// The specification's own fixture corpus, read by the .NET models.
/// </summary>
/// <remarks>
/// <para>
/// <c>spec/draft/fixtures</c> is the behavioural contract every SDK is judged
/// against, and until now .NET ran only the VALID half of it (through the
/// protobuf round-trip suite). The invalid half was where the divergences hid:
/// a <c>CUSTOM</c> with no <c>value</c>, a token count of <c>-5</c>, a
/// <c>delta</c> that was not a patch — all documents TypeScript and Python
/// reject and .NET read without complaint.
/// </para>
/// <para>
/// So this suite runs both halves, and pins the invalid half in BOTH
/// directions: exactly the documents listed in <see cref="Tolerated"/> may
/// parse. One that stops parsing is a tolerance silently lost; one that starts
/// parsing is a rule silently dropped. The same shape Python's
/// <c>TOLERATED_INVALID</c> uses, for the same reason.
/// </para>
/// </remarks>
public sealed class SchemaCorpusFixtureTest
{
    private static readonly JsonSerializerOptions s_options = AGUIJsonSerializerContext.Default.Options;

    /// <summary>
    /// Invalid documents the .NET models still read, each with the reason.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> Tolerated =
        new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // Unknown members survive the parse rather than failing it: the
            // models are tolerant readers, and the enforcement stage is what
            // strips. Same tolerance Python records.
            ["AgentCapabilities/invalid/old-subagents-key.json"] = "unknown-keys",
            ["MultiAgentCapabilities/invalid/old-subagents-key.json"] = "unknown-keys",
            ["FileSource/invalid/reference-record.json"] = "unknown-keys",
            ["TextMessageEndEvent/invalid/unknown-property.json"] = "unknown-keys",
            ["RunFinishedEvent/invalid/outcome-success-carrying-interrupts.json"] = "unknown-keys",
            ["RunFinishedEvent/invalid/outcome-cancelled-carrying-interrupts.json"] = "unknown-keys",
            ["RunFinishedEvent/invalid/outcome-interrupt-carrying-pending-tool-call-ids.json"] = "unknown-keys",
            ["SubagentFinishedEvent/invalid/outcome-success-carrying-interrupt-ids.json"] = "unknown-keys",

            // A whole optional field written as null reads as absent, under the
            // repo-root DEPRECATIONS.md shim — announced now, not silent
            // (AGUIWireGuard), but still accepted until the shim expires.
            ["AgentCapabilities/invalid/custom-null.json"] = "null-means-absent",
            ["AgentCapabilities/invalid/metadata-null.json"] = "null-means-absent",
            ["MessagesSnapshotEvent/invalid/message-metadata-null.json"] = "null-means-absent",
            ["RunFinishedEvent/invalid/outcome-null.json"] = "null-means-absent",
            ["SubagentErrorEvent/invalid/code-null.json"] = "null-means-absent",
            ["SubagentFinishedEvent/invalid/outcome-null.json"] = "null-means-absent",
            ["SubagentStartedEvent/invalid/description-null.json"] = "null-means-absent",
            ["TextMessageContentEvent/invalid/metadata-null.json"] = "null-means-absent",
            ["TextMessageContentEvent/invalid/subagent-run-id-null.json"] = "null-means-absent",
            ["TextMessageEndEvent/invalid/raw-event-null.json"] = "null-means-absent",
            ["ToolCallChunkEvent/invalid/parent-message-id-null.json"] = "null-means-absent",
            ["ToolCallStartEvent/invalid/parent-message-id-null.json"] = "null-means-absent",

            // A required string is a non-nullable property with an empty
            // default, so an absent one reads as "" rather than failing.
            ["CustomEvent/invalid/name-missing.json"] = "required-string-defaults-to-empty",
            ["FileSource/invalid/value-missing.json"] = "required-string-defaults-to-empty",
            ["Interrupt/invalid/reason-missing.json"] = "required-string-defaults-to-empty",
            ["SubagentInfo/invalid/name-missing.json"] = "required-string-defaults-to-empty",
            ["Tool/invalid/name-missing.json"] = "required-string-defaults-to-empty",
            ["ToolMessage/invalid/tool-call-id-missing.json"] = "required-string-defaults-to-empty",
            ["UserMessage/invalid/content-missing.json"] = "required-string-defaults-to-empty",
            ["UserMessage/invalid/file-source-value-missing.json"] = "required-string-defaults-to-empty",
            ["RunAgentInput/invalid/messages-missing.json"] = "required-list-defaults-to-empty",

            // The const that names a member is a computed property here, so a
            // document omitting it still lands on the member it belongs to.
            ["ReasoningMessageStartEvent/invalid/role-missing.json"] = "const-fills-in",

            // A closed value set rides as a plain string in this SDK, so a
            // value outside it parses. Recorded as a gap in processing.mdx and
            // in the conformance fixture overrides; not this suite's to close.
            ["ResumeEntry/invalid/unknown-status.json"] = "closed-set-rides-as-string",
            ["ReasoningEncryptedValueEvent/invalid/unknown-subtype.json"] = "closed-set-rides-as-string",
            ["ToolCallResultEvent/invalid/role-not-tool.json"] = "closed-set-rides-as-string",
            ["TextMessageContentEvent/invalid/delta-missing.json"] = "required-string-defaults-to-empty",

            // The three subagent events declare their required strings nullable
            // rather than empty-defaulted, so an absent one reads as null.
            ["SubagentStartedEvent/invalid/name-missing.json"] = "required-string-stays-null",

            // A required open record is a bare JsonElement here, and the guard
            // judges its PRESENCE, not its kind: a content that is a string
            // parses. The kind check has no home yet.
            ["ActivitySnapshotEvent/invalid/content-not-an-object.json"] = "open-record-kind-unchecked",

            // An op RFC 6902 does not define is an unrecognised union member,
            // which TypeScript drops from the patch rather than failing on
            // (conformance stream state-delta-unknown-op-dropped); .NET carries
            // the patch as opaque JSON and passes it along.
            ["StateDeltaEvent/invalid/patch-unknown-op.json"] = "unknown-op-tolerated",
        };

    // Walked up from the test binary rather than taken from [CallerFilePath]:
    // CI's deterministic source paths rewrite a caller path to "/_/...".
    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !Directory.Exists(Path.Combine(dir.FullName, "spec", "draft", "fixtures")))
        {
            dir = dir.Parent;
        }

        return dir?.FullName
            ?? throw new DirectoryNotFoundException(
                $"No repository root above '{AppContext.BaseDirectory}' carries spec/draft/fixtures.");
    }

    private static readonly string s_fixturesDir = Path.Combine(RepoRoot(), "spec", "draft", "fixtures");

    /// <summary>
    /// The .NET type each fixture anchor is read as. Events and messages go
    /// through their union base, because that is how a consumer meets them.
    /// </summary>
    private static Type TypeForAnchor(string anchor) => anchor switch
    {
        _ when anchor.EndsWith("Event", StringComparison.Ordinal) => typeof(BaseEvent),
        "UserMessage" or "ToolMessage" => typeof(AGUIMessage),
        "FileSource" => typeof(AGUIInputContentSource),
        "Interrupt" => typeof(AGUIInterrupt),
        "ResumeEntry" => typeof(AGUIResume),
        "Tool" => typeof(AGUITool),
        "RunAgentInput" => typeof(RunAgentInput),
        "SubagentInfo" => typeof(SubagentInfo),
        "AgentCapabilities" => typeof(AgentCapabilities),
        "ExecutionCapabilities" => typeof(ExecutionCapabilities),
        "MultiAgentCapabilities" => typeof(MultiAgentCapabilities),
        _ => throw new InvalidOperationException(
            $"No .NET type is mapped for the fixture anchor '{anchor}'. Every anchor the corpus " +
            "gains needs one here, or the new fixtures run against nothing."),
    };

    private static TheoryData<string, string, string> Fixtures(string half)
    {
        var data = new TheoryData<string, string, string>();
        foreach (var anchorDir in Directory.GetDirectories(s_fixturesDir).OrderBy(d => d, StringComparer.Ordinal))
        {
            var anchor = Path.GetFileName(anchorDir);
            var dir = Path.Combine(anchorDir, half);
            if (!Directory.Exists(dir))
            {
                continue;
            }

            foreach (var file in Directory.GetFiles(dir, "*.json").OrderBy(f => f, StringComparer.Ordinal))
            {
                if (file.EndsWith(".expect.json", StringComparison.Ordinal))
                {
                    continue;
                }

                var name = $"{anchor}/{half}/{Path.GetFileName(file)}";
                data.Add(name, anchor, file);
            }
        }

        return data;
    }

    public static TheoryData<string, string, string> ValidFixtures() => Fixtures("valid");

    public static TheoryData<string, string, string> InvalidFixtures() => Fixtures("invalid");

    private static void Parse(string anchor, string path)
    {
        var json = File.ReadAllText(path);
        JsonSerializer.Deserialize(json, s_options.GetTypeInfo(TypeForAnchor(anchor)));
    }

    [Theory]
    [MemberData(nameof(ValidFixtures))]
    public void ValidFixture_Parses(string name, string anchor, string path)
    {
        var error = Record.Exception(() => Parse(anchor, path));
        Assert.True(error is null, $"{name} is valid but did not parse: {error?.Message}");
    }

    [Theory]
    [MemberData(nameof(InvalidFixtures))]
    public void InvalidFixture_IsRejectedExceptForTheRecordedTolerances(string name, string anchor, string path)
    {
        var error = Record.Exception(() => Parse(anchor, path));
        if (error is null)
        {
            Assert.True(
                Tolerated.ContainsKey(name),
                $"{name} is invalid and .NET read it anyway. Reject it, or record the tolerance with its reason.");
            return;
        }

        Assert.False(
            Tolerated.ContainsKey(name),
            $"{name} is recorded as tolerated ({Tolerated.GetValueOrDefault(name)}) but was rejected: " +
            $"{error.Message}. Remove the entry — a tolerance that quietly became a rejection is a " +
            "behaviour change nobody reviewed.");
    }

    /// <summary>
    /// A tolerance for a fixture that no longer exists is a record of nothing.
    /// </summary>
    [Fact]
    public void EveryRecordedToleranceNamesAFixtureThatExists()
    {
        foreach (var name in Tolerated.Keys)
        {
            Assert.True(
                File.Exists(Path.Combine(s_fixturesDir, name.Replace('/', Path.DirectorySeparatorChar))),
                $"{name} is recorded as tolerated but is not in the corpus.");
        }
    }
}
